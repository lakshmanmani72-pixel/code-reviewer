import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ExtensionConfig } from './types';

/**
 * Reads extension configuration from VS Code settings.
 */
export function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('prCodeReviewer');
    return {
        githubToken: config.get<string>('githubToken', ''),
        webhookPort: config.get<number>('webhookPort', 7890),
        webhookSecret: config.get<string>('webhookSecret', ''),
        autoReviewOnPR: config.get<boolean>('autoReviewOnPR', true),
        owner: config.get<string>('owner', ''),
        repo: config.get<string>('repo', ''),
        reviewChecks: config.get('reviewChecks', {
            largeFiles: true,
            debugStatements: true,
            todoComments: true,
            securityPatterns: true,
            codeComplexity: true,
            namingConventions: true,
            duplicateCode: true,
            mergeConflicts: true,
        }),
        maxFileSizeKB: config.get<number>('maxFileSizeKB', 500),
    };
}

/**
 * Detects owner and repo from the current workspace git remote.
 * Tries VS Code Git API first, then falls back to git CLI.
 */
export async function detectRepoFromWorkspace(): Promise<{ owner: string; repo: string } | null> {
    // Method 1: Try VS Code Git extension API
    try {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            if (!gitExtension.isActive) {
                await gitExtension.activate();
            }
            const git = gitExtension.exports.getAPI(1);
            const repositories = git.repositories;
            if (repositories.length > 0) {
                const repo = repositories[0];
                const remotes = repo.state.remotes;
                const origin = remotes.find((r: any) => r.name === 'origin');
                if (origin?.fetchUrl) {
                    const match = origin.fetchUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
                    if (match) {
                        return { owner: match[1], repo: match[2] };
                    }
                }
            }
        }
    } catch (e) {
        // Git extension API failed, try CLI fallback
    }

    // Method 2: Fallback to git CLI
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const cwd = workspaceFolders[0].uri.fsPath;
            const remoteUrl = await runGitCommand('git remote get-url origin', cwd);
            if (remoteUrl) {
                const match = remoteUrl.trim().match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
                if (match) {
                    return { owner: match[1], repo: match[2] };
                }
            }
        }
    } catch (e) {
        // CLI fallback also failed
    }

    return null;
}

/**
 * Run a git command and return stdout.
 */
function runGitCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { cwd }, (err, stdout, stderr) => {
            if (err) { reject(err); }
            else { resolve(stdout.toString().trim()); }
        });
    });
}
