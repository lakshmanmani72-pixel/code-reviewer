import * as vscode from 'vscode';
import { GitHubService } from './githubService';
import { WebhookServer } from './webhookServer';
import { ReviewPanel } from './reviewPanel';
import { AIReviewService } from './aiReviewService';
import { ChecklistPanel } from './checklistPanel';
import {
    PullRequestTreeProvider,
    ReviewResultsTreeProvider,
    WebhookStatusTreeProvider,
} from './treeViews';
import { getConfig, detectRepoFromWorkspace } from './config';
import { ReviewResult, WebhookEvent } from './types';

let githubService: GitHubService | null = null;
let webhookServer: WebhookServer | null = null;

// Store review results for re-check
let lastReviewResult: ReviewResult | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('PR Code Reviewer is now active');

    // ── Tree View Providers ────────────────────────────────
    const prTreeProvider = new PullRequestTreeProvider();
    const reviewTreeProvider = new ReviewResultsTreeProvider();
    const webhookTreeProvider = new WebhookStatusTreeProvider();

    vscode.window.registerTreeDataProvider('prCodeReviewer.pullRequests', prTreeProvider);
    vscode.window.registerTreeDataProvider('prCodeReviewer.reviewResults', reviewTreeProvider);
    vscode.window.registerTreeDataProvider('prCodeReviewer.webhookStatus', webhookTreeProvider);

    // Track current repo so we can detect when user switches
    let currentOwner = '';
    let currentRepo = '';

    // ── Helper: Get GitHub token ───────────────────────────
    async function getGitHubToken(): Promise<string | null> {
        const config = getConfig();
        let token = config.githubToken;

        if (!token) {
            token = await context.secrets.get('prCodeReviewer.githubToken') || '';
        }

        if (!token) {
            token = await vscode.window.showInputBox({
                prompt: 'Enter your GitHub Personal Access Token (one-time setup)',
                password: true,
                placeHolder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
                ignoreFocusOut: true,
            }) || '';

            if (!token) {
                vscode.window.showWarningMessage('GitHub token is required.');
                return null;
            }

            await context.secrets.store('prCodeReviewer.githubToken', token);
            await vscode.workspace.getConfiguration('prCodeReviewer').update('githubToken', token, true);
        }

        return token;
    }

    // ── Helper: Ask user for repo (owner/repo) ─────────────
    async function askForRepo(): Promise<{ owner: string; repo: string } | null> {
        // Build a default suggestion from git remote or settings
        let defaultValue = '';
        const config = getConfig();
        if (config.owner && config.repo) {
            defaultValue = `${config.owner}/${config.repo}`;
        } else {
            const detected = await detectRepoFromWorkspace();
            if (detected) {
                defaultValue = `${detected.owner}/${detected.repo}`;
            }
        }

        const input = await vscode.window.showInputBox({
            prompt: 'Enter the GitHub repository to review (owner/repo)',
            placeHolder: 'e.g. Anish-1910/demo-test-repo',
            value: defaultValue,
            ignoreFocusOut: true,
            validateInput: (value) => {
                const parts = value.trim().split('/');
                if (parts.length !== 2 || !parts[0] || !parts[1]) {
                    return 'Format must be owner/repo (e.g. Anish-1910/demo-test-repo)';
                }
                return null;
            },
        });

        if (!input) { return null; }

        const [owner, repo] = input.trim().split('/');
        return { owner, repo };
    }

    // ── Helper: Initialize GitHub service ──────────────────
    async function ensureGitHubService(owner: string, repo: string): Promise<GitHubService | null> {
        const token = await getGitHubToken();
        if (!token) { return null; }

        // If same repo and already connected, reuse
        if (githubService && currentOwner === owner && currentRepo === repo) {
            return githubService;
        }

        // New repo or first time — create fresh service
        githubService = new GitHubService(token, owner, repo);
        currentOwner = owner;
        currentRepo = repo;

        const connected = await githubService.verifyConnection();
        if (!connected) {
            vscode.window.showErrorMessage(`Failed to connect to ${owner}/${repo}. Check your token and repo name.`);
            githubService = null;
            return null;
        }

        // Save for next time as default
        await vscode.workspace.getConfiguration('prCodeReviewer').update('owner', owner, true);
        await vscode.workspace.getConfiguration('prCodeReviewer').update('repo', repo, true);

        vscode.window.showInformationMessage(`✔ Connected to ${owner}/${repo}`);
        return githubService;
    }

    // ── Helper: Run review on a PR ─────────────────────────
    async function runReview(prNumber: number, owner?: string, repo?: string): Promise<void> {
        // If owner/repo not provided, use current or ask
        if (!owner || !repo) {
            if (currentOwner && currentRepo) {
                owner = currentOwner;
                repo = currentRepo;
            } else {
                const repoInfo = await askForRepo();
                if (!repoInfo) { return; }
                owner = repoInfo.owner;
                repo = repoInfo.repo;
            }
        }

        const github = await ensureGitHubService(owner, repo);
        if (!github) { return; }

        const config = getConfig();

        // Show loading panel
        const panel = ReviewPanel.createOrShow(context.extensionUri);
        panel.showLoading(prNumber);

        // Listen for recheck from WebView
        panel.onRecheck(async (recheckPrNumber) => {
            vscode.window.showInformationMessage(`🔄 Re-checking PR #${recheckPrNumber}...`);
            await runReview(recheckPrNumber);
        });

        // Ensure Groq API key is configured
        let geminiKey = vscode.workspace.getConfiguration('prCodeReviewer').get<string>('geminiApiKey', '');
        if (!geminiKey) {
            geminiKey = await vscode.window.showInputBox({
                prompt: 'Enter your Groq API key (required for AI review)',
                password: true,
                placeHolder: 'Paste Groq API key — get one at console.groq.com/keys',
                ignoreFocusOut: true,
            }) || '';
            if (!geminiKey) {
                vscode.window.showWarningMessage('Groq API key is required for review.');
                return;
            }
            await vscode.workspace.getConfiguration('prCodeReviewer').update('geminiApiKey', geminiKey, true);
        }

        try {
            // Fetch PR data
            const pr = await github.getPullRequest(prNumber);
            const files = await github.getPullRequestFiles(prNumber);

            vscode.window.showInformationMessage(
                `🤖 AI-reviewing PR #${prNumber}: ${files.length} files with ${AIReviewService.LLM_NAME}...`
            );

            // Set pending status on the commit
            try {
                await github.createCommitStatus(pr.head.sha, 'pending', 'AI code review in progress...');
            } catch (e) {
                // Non-critical, may not have permission
            }

            // Build enabled categories & custom rules
            const enabledCategories = Object.entries(config.reviewChecks)
                .filter(([_, v]) => v)
                .map(([k]) => k);
            const customRules = vscode.workspace.getConfiguration('prCodeReviewer').get<string[]>('customReviewRules', []);

            // Run AI-powered review (sole engine)
            const aiService = new AIReviewService(geminiKey);
            const result = await aiService.reviewPullRequest(
                prNumber,
                pr.title,
                pr.head.ref,
                pr.head.sha,
                files,
                enabledCategories,
                customRules
            );

            lastReviewResult = result;

            // Show results in WebView panel
            panel.showReview(result);

            // Update tree views
            reviewTreeProvider.setReviewResult(result);

            // Post commit status
            try {
                const statusState = result.status === 'pass' ? 'success'
                    : result.status === 'warn' ? 'success'
                        : 'failure';
                await github.createCommitStatus(
                    pr.head.sha,
                    statusState,
                    `${result.summary.totalIssues} issues found (${result.summary.errors} errors, ${result.summary.warnings} warnings)`
                );
            } catch (e) {
                // Non-critical
            }

            // Submit a PR review that BLOCKS merge on errors or APPROVES if clean
            try {
                const commentBody = buildReviewComment(result);
                if (result.status === 'fail') {
                    // REQUEST_CHANGES blocks the merge button on GitHub
                    await github.submitReview(
                        prNumber,
                        'REQUEST_CHANGES',
                        commentBody + '\n\n> **⛔ MERGE BLOCKED — Please fix the errors above and re-check the feature branch before merging.**'
                    );
                    vscode.window.showWarningMessage(
                        `⛔ PR #${prNumber}: Merge BLOCKED — ${result.summary.errors} error(s) found. Fix issues and re-check before merging.`
                    );
                } else if (result.status === 'warn') {
                    // Post as COMMENT with warnings (doesn't block but flags)
                    await github.submitReview(
                        prNumber,
                        'COMMENT',
                        commentBody + '\n\n> **⚠️ Warnings found. Please review before merging. Re-check recommended.**'
                    );
                } else {
                    // APPROVE allows merge
                    await github.submitReview(
                        prNumber,
                        'APPROVE',
                        commentBody + '\n\n> **✅ Code review passed. Feature branch is approved for merge.**'
                    );
                }
            } catch (e: any) {
                // Fallback: post as a regular comment if review submission fails
                console.warn('Failed to submit PR review, falling back to comment:', e.message);
                try {
                    const commentBody = buildReviewComment(result);
                    await github.postPRComment(prNumber, commentBody);
                } catch (e2) {
                    console.warn('Failed to post PR comment:', e2);
                }
            }

            // Show notification with summary and action buttons
            const action = result.status === 'fail'
                ? `⛔ ${result.summary.errors} error(s) found — MERGE BLOCKED. Fix issues first.`
                : result.status === 'warn'
                    ? '⚠️ Review passed with warnings. Please review before merging.'
                    : '✅ Review passed! Feature branch approved for merge.';

            const buttonChoice = await vscode.window.showInformationMessage(
                `Review complete for PR #${prNumber}: ${result.summary.totalIssues} issues. ${action}`,
                'View Details',
                'Re-check Branch'
            );

            if (buttonChoice === 'Re-check Branch') {
                await runReview(prNumber);
            }

        } catch (err: any) {
            vscode.window.showErrorMessage(`Review failed: ${err.message}`);
        }
    }

    // ── Command: Configure PAT ─────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.configurePAT', async () => {
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your GitHub Personal Access Token',
                password: true,
                placeHolder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
                ignoreFocusOut: true,
            });

            if (token) {
                await context.secrets.store('prCodeReviewer.githubToken', token);
                await vscode.workspace.getConfiguration('prCodeReviewer').update('githubToken', token, true);
                vscode.window.showInformationMessage('✔ GitHub token saved successfully.');
                githubService = null; // Reset to re-initialize with new token
            }
        })
    );

    // ── Command: List Open PRs ─────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.listOpenPRs', async () => {
            const repoInfo = await askForRepo();
            if (!repoInfo) { return; }

            const github = await ensureGitHubService(repoInfo.owner, repoInfo.repo);
            if (!github) { return; }

            try {
                const prs = await github.listOpenPullRequests();
                prTreeProvider.setPullRequests(prs);

                if (prs.length === 0) {
                    vscode.window.showInformationMessage('No open pull requests found.');
                } else {
                    vscode.window.showInformationMessage(`Found ${prs.length} open pull request(s).`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to fetch PRs: ${err.message}`);
            }
        })
    );

    // ── Helper: Parse PR number from input like "3", "#3", "PR #3" ──
    function parsePRNumber(input: string): number | null {
        const cleaned = input.replace(/^\s*(pr\s*)?#?\s*/i, '').trim();
        const num = parseInt(cleaned, 10);
        return isNaN(num) ? null : num;
    }

    // ── Command: Review Current PR ─────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.reviewCurrentPR', async (prNumber?: number) => {
            // Step 1: Ask which repo
            const repoInfo = await askForRepo();
            if (!repoInfo) { return; }

            // Step 2: Ask for PR number
            if (!prNumber) {
                const input = await vscode.window.showInputBox({
                    prompt: `Enter Pull Request number for ${repoInfo.owner}/${repoInfo.repo} (e.g. 1 or #1)`,
                    placeHolder: '#1',
                    validateInput: (value) => {
                        return parsePRNumber(value) !== null ? null : 'Enter a valid PR number (e.g. 1, #1, PR #1)';
                    },
                });
                if (!input) { return; }
                prNumber = parsePRNumber(input)!;
            }

            await runReview(prNumber, repoInfo.owner, repoInfo.repo);
        })
    );

    // ── Command: Re-check Branch ───────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.recheckBranch', async () => {
            if (lastReviewResult) {
                vscode.window.showInformationMessage(
                    `🔄 Re-checking feature branch for PR #${lastReviewResult.prNumber}...`
                );
                await runReview(lastReviewResult.prNumber);
            } else {
                // Ask for PR number
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter the Pull Request number to re-check',
                    placeHolder: 'e.g., 42',
                });
                if (input) {
                    await runReview(parseInt(input, 10));
                }
            }
        })
    );

    // ── Command: Open Review Panel ─────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.openReviewPanel', () => {
            if (lastReviewResult) {
                const panel = ReviewPanel.createOrShow(context.extensionUri);
                panel.showReview(lastReviewResult);
            } else {
                vscode.window.showInformationMessage('No review results available. Run a review first.');
            }
        })
    );

    // ── Command: Open Review Checklist ─────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.openChecklist', () => {
            const panel = ChecklistPanel.createOrShow();
            panel.onRunReview(async () => {
                // If there's a last reviewed PR, re-check it
                if (lastReviewResult) {
                    await runReview(lastReviewResult.prNumber);
                } else {
                    vscode.commands.executeCommand('prCodeReviewer.reviewCurrentPR');
                }
            });
        })
    );

    // ── Command: Show API Endpoints ────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.showEndpoints', () => {
            const info = AIReviewService.getEndpointInfo();
            const config = getConfig();
            info.webhookEndpoint = `http://localhost:${config.webhookPort}/webhook`;

            const hasKey = !!vscode.workspace.getConfiguration('prCodeReviewer').get<string>('geminiApiKey', '');

            vscode.window.showInformationMessage(
                `APIs — GitHub: api.github.com | AI: ${info.llmName} (${hasKey ? '✅ Ready' : '❌ No Key'}) | Webhook: localhost:${config.webhookPort}`,
                'Open Checklist'
            ).then(choice => {
                if (choice === 'Open Checklist') {
                    vscode.commands.executeCommand('prCodeReviewer.openChecklist');
                }
            });
        })
    );

    // ── Command: Start Webhook Server ──────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.startWebhookServer', async () => {
            const config = getConfig();

            if (webhookServer?.isRunning) {
                vscode.window.showWarningMessage('Webhook server is already running.');
                return;
            }

            webhookServer = new WebhookServer(config.webhookPort, config.webhookSecret);
            webhookTreeProvider.setStatus(false, config.webhookPort);

            // Handle PR events from webhooks
            webhookServer.onPullRequestEvent(async (event: WebhookEvent) => {
                webhookTreeProvider.addEvent(
                    `PR #${event.number} ${event.action} by ${event.sender.login}`
                );

                if (config.autoReviewOnPR) {
                    // Use repo info from webhook payload directly
                    const webhookOwner = event.repository.owner.login;
                    const webhookRepo = event.repository.name;

                    await runReview(event.number, webhookOwner, webhookRepo);
                } else {
                    const choice = await vscode.window.showInformationMessage(
                        `PR #${event.number} "${event.pull_request.title}" — ${event.action}. Review now?`,
                        'Review',
                        'Dismiss'
                    );
                    if (choice === 'Review') {
                        await runReview(event.number, event.repository.owner.login, event.repository.name);
                    }
                }
            });

            webhookServer.onStatusChange((running) => {
                webhookTreeProvider.setStatus(running, config.webhookPort);
            });

            try {
                await webhookServer.start();
                webhookTreeProvider.setStatus(true, config.webhookPort);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to start webhook server: ${err.message}`);
            }
        })
    );

    // ── Command: Stop Webhook Server ───────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('prCodeReviewer.stopWebhookServer', async () => {
            if (webhookServer) {
                await webhookServer.stop();
                webhookTreeProvider.setStatus(false, 0);
            } else {
                vscode.window.showInformationMessage('Webhook server is not running.');
            }
        })
    );

    // ── Auto-detect repo on activation (just for defaults) ──
    (async () => {
        const config = getConfig();
        if (config.owner && config.repo) {
            currentOwner = config.owner;
            currentRepo = config.repo;
        } else {
            const detected = await detectRepoFromWorkspace();
            if (detected) {
                currentOwner = detected.owner;
                currentRepo = detected.repo;
                await vscode.workspace.getConfiguration('prCodeReviewer').update('owner', detected.owner, true);
                await vscode.workspace.getConfiguration('prCodeReviewer').update('repo', detected.repo, true);
            }
        }
    })();
}

/**
 * Build a Markdown review comment to post on the PR.
 */
function buildReviewComment(result: ReviewResult): string {
    const statusEmoji = result.status === 'pass' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
    const header = `## ${statusEmoji} Automated Code Review — PR #${result.prNumber}`;

    const summary = [
        `| Metric | Count |`,
        `|--------|-------|`,
        `| Files Reviewed | ${result.summary.totalFiles} |`,
        `| Total Issues | ${result.summary.totalIssues} |`,
        `| 🔴 Errors | ${result.summary.errors} |`,
        `| 🟡 Warnings | ${result.summary.warnings} |`,
        `| 🔵 Info | ${result.summary.info} |`,
        `| 🟢 Suggestions | ${result.summary.suggestions} |`,
    ].join('\n');

    let filesSection = '';
    const filesWithIssues = result.files.filter(f => f.issues.length > 0);
    if (filesWithIssues.length > 0) {
        filesSection = '\n\n### Files with Issues\n\n';
        for (const file of filesWithIssues) {
            filesSection += `<details>\n<summary><strong>${file.filename}</strong> — ${file.issues.length} issue(s)</summary>\n\n`;
            for (const issue of file.issues) {
                const icon = issue.severity === 'error' ? '🔴'
                    : issue.severity === 'warning' ? '🟡'
                        : issue.severity === 'info' ? '🔵' : '🟢';
                filesSection += `- ${icon} **Line ${issue.line}** [${issue.category}]: ${issue.message}\n`;
                if (issue.snippet) {
                    filesSection += `  \`\`\`\n  ${issue.snippet}\n  \`\`\`\n`;
                }
                if (issue.suggestion) {
                    filesSection += `  > 💡 ${issue.suggestion}\n`;
                }
            }
            filesSection += `\n</details>\n`;
        }
    }

    const recommendation = result.status === 'fail'
        ? '\n\n> **⛔ Please address the errors above before merging. Re-check the feature branch after fixes.**'
        : result.status === 'warn'
            ? '\n\n> **⚠️ Warnings found. Please review and consider fixing before merging. Re-check recommended.**'
            : '\n\n> **✅ No critical issues found. Feature branch looks ready for merge after final human review.**';

    const footer = `\n\n---\n*Reviewed by PR Code Reviewer Extension at ${new Date(result.timestamp).toLocaleString()}*\n*Review Engine: 🤖 ${AIReviewService.LLM_NAME} (AI-Powered)*\n*GitHub API: api.github.com | AI Endpoint: ${AIReviewService.API_ENDPOINT}*`;

    return `${header}\n\n${summary}${filesSection}${recommendation}${footer}`;
}

export function deactivate() {
    if (webhookServer) {
        webhookServer.dispose();
    }
    if (ReviewPanel.currentPanel) {
        ReviewPanel.currentPanel.dispose();
    }
}
