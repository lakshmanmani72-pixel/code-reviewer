import * as https from 'https';
import * as vscode from 'vscode';
import { ReviewIssue, ReviewResult, ReviewSummary, FileReviewResult, ReviewCategory, PRFile } from './types';

/**
 * AI-Powered Code Review Engine using Groq API (Llama 3.3 70B).
 *
 * This is the SOLE review engine — all analysis is done by the LLM.
 * Custom review rules added by the developer are injected as additional prompts.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  LLM:       Llama 3.3 70B Versatile                    │
 * │  Model ID:  llama-3.3-70b-versatile                     │
 * │  Provider:  Groq (Ultra-fast LLM inference)             │
 * │  Endpoint:  api.groq.com/openai/v1/chat/completions     │
 * │  Auth:      Bearer token (API Key)                      │
 * │  Free Tier: 30 req/min, 1000 req/day, 131k context      │
 * └─────────────────────────────────────────────────────────┘
 */
export class AIReviewService {
    private apiKey: string;

    // ── Public constants for display ──────────────────────
    public static readonly LLM_NAME = 'Llama 3.3 70B Versatile';
    public static readonly LLM_MODEL = 'llama-3.3-70b-versatile';
    public static readonly API_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
    public static readonly PROVIDER = 'Groq (Ultra-fast LLM Inference)';

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /** Get all endpoint info for displaying in the UI */
    static getEndpointInfo(): {
        llmName: string;
        model: string;
        endpoint: string;
        provider: string;
        githubApi: string;
        webhookEndpoint: string;
    } {
        return {
            llmName: AIReviewService.LLM_NAME,
            model: AIReviewService.LLM_MODEL,
            endpoint: AIReviewService.API_ENDPOINT,
            provider: AIReviewService.PROVIDER,
            githubApi: 'https://api.github.com',
            webhookEndpoint: 'http://localhost:{port}/webhook',
        };
    }

    /**
     * Full PR review — the main entry point.
     * Sends all file diffs to Groq (Llama 3.3 70B) and returns a complete ReviewResult.
     */
    async reviewPullRequest(
        prNumber: number,
        prTitle: string,
        branchName: string,
        headSha: string,
        files: PRFile[],
        enabledCategories: string[],
        customRules: string[]
    ): Promise<ReviewResult> {
        const fileResults: FileReviewResult[] = [];
        const allIssues: ReviewIssue[] = [];

        // Filter reviewable files (skip removed, skip huge patches)
        const reviewableFiles = files.filter(f =>
            f.status !== 'removed' && f.patch && f.patch.length > 0
        );

        // Batch files into chunks to stay within token limits (~25k chars ≈ ~6k tokens)
        const batches = this.batchFiles(reviewableFiles, 25000);

        let apiErrorOccurred = false;
        let lastApiError = '';

        for (let bIdx = 0; bIdx < batches.length; bIdx++) {
            const batch = batches[bIdx];
            const prompt = this.buildReviewPrompt(batch, enabledCategories, customRules);
            try {
                vscode.window.showInformationMessage(
                    `🔍 Analyzing batch ${bIdx + 1}/${batches.length} (${batch.length} files) via Groq...`
                );
                const response = await this.callGroqWithRetry(prompt);
                const issues = this.parseAIResponse(response);
                allIssues.push(...issues);
            } catch (err: any) {
                apiErrorOccurred = true;
                lastApiError = err.message;
                console.error(`Groq API call failed for batch ${bIdx + 1}:`, err.message);
                vscode.window.showErrorMessage(
                    `⚠️ Groq API error (batch ${bIdx + 1}/${batches.length}): ${err.message}`
                );
            }
        }

        // If ALL batches failed and we had files to review, add an error issue
        if (apiErrorOccurred && allIssues.length === 0 && reviewableFiles.length > 0) {
            allIssues.push({
                id: 'ai-api-error',
                file: reviewableFiles[0].filename,
                line: 0,
                severity: 'error',
                category: 'best-practice',
                message: `AI review failed: ${lastApiError}. Check your Groq API key and try again.`,
                suggestion: 'Get a free API key at https://console.groq.com/keys',
            });
        }

        // Build file results
        for (const file of files) {
            const fileIssues = allIssues.filter(i => i.file === file.filename);
            fileResults.push({
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                issues: fileIssues,
            });
        }

        const summary = this.buildSummary(allIssues, files.length);
        const status: 'pass' | 'warn' | 'fail' =
            summary.errors > 0 ? 'fail'
                : summary.warnings > 0 ? 'warn'
                    : 'pass';

        return {
            prNumber,
            prTitle,
            branchName,
            timestamp: new Date().toISOString(),
            summary,
            issues: allIssues,
            files: fileResults,
            status,
        };
    }

    // ── Prompt Builder ──────────────────────────────────────

    private buildReviewPrompt(
        files: PRFile[],
        enabledCategories: string[],
        customRules: string[]
    ): string {
        const fileDiffs = files
            .map(f => `\n### File: ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
            .join('\n');

        const categories = enabledCategories.length > 0
            ? enabledCategories.join(', ')
            : 'security, performance, error-handling, best-practices, code-quality, naming, complexity, debug-statements, todo-comments';

        let customSection = '';
        if (customRules.length > 0) {
            customSection = `\n\nADDITIONAL REVIEW RULES (from the developer — treat these as MANDATORY checks):\n${customRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
        }

        return `You are a world-class senior code reviewer performing an automated pull request review.
Analyze the following PR diff thoroughly and identify ALL issues.

REVIEW CATEGORIES TO CHECK: ${categories}
${customSection}

For EVERY issue found, respond in EXACTLY this JSON format (array of objects):
[
  {
    "file": "filename.js",
    "line": 10,
    "severity": "error",
    "category": "security",
    "message": "Clear, specific description of the issue",
    "suggestion": "Concrete fix or improvement",
    "snippet": "the problematic code line"
  }
]

SEVERITY DEFINITIONS (be accurate):
- "error"      → WILL cause bugs, crashes, security vulnerabilities, data loss, or injection attacks
- "warning"    → BAD practice that COULD lead to problems
- "info"       → Minor improvement or code smell
- "suggestion" → Optional enhancement

CATEGORY VALUES (use exactly these):
"security", "performance", "error-handling", "best-practice", "complexity", "naming", "debug-statement", "todo-comment", "large-file", "merge-conflict", "duplicate-code"

IMPORTANT:
- Focus on ADDED lines (lines starting with + in the diff), not removed lines
- Be specific — include the actual problematic code in "snippet"
- Line numbers should match the diff's @@ hunk headers
- Do NOT flag trivial style issues — only substantial problems
- If you find NOTHING wrong, return an empty array: []
- Respond with ONLY the raw JSON array. No markdown fences, no explanations.

PR DIFF TO REVIEW:
${fileDiffs}`;
    }

    // ── File Batching ───────────────────────────────────────

    private batchFiles(files: PRFile[], maxChars: number): PRFile[][] {
        const batches: PRFile[][] = [];
        let current: PRFile[] = [];
        let currentSize = 0;

        for (const file of files) {
            const patchSize = file.patch?.length || 0;
            if (currentSize + patchSize > maxChars && current.length > 0) {
                batches.push(current);
                current = [];
                currentSize = 0;
            }
            current.push(file);
            currentSize += patchSize;
        }
        if (current.length > 0) { batches.push(current); }
        return batches.length > 0 ? batches : [[]];
    }

    // ── Groq API Call with Retry ────────────────────────────

    private async callGroqWithRetry(prompt: string, maxRetries: number = 3): Promise<string> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.callGroq(prompt);
            } catch (err: any) {
                const is429 = err.message?.includes('429');
                if (is429 && attempt < maxRetries) {
                    const waitSec = attempt * 10; // 10s, 20s
                    vscode.window.showWarningMessage(
                        `⏳ Rate limited — waiting ${waitSec}s before retry ${attempt + 1}/${maxRetries}...`
                    );
                    await this.sleep(waitSec * 1000);
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Groq API: max retries exhausted');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Call the Groq API (OpenAI-compatible chat completions endpoint).
     * Uses Bearer token auth, NOT query-parameter auth like Gemini.
     */
    private callGroq(prompt: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model: AIReviewService.LLM_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a code review assistant. You analyze code diffs and return issues as a JSON array. Respond with ONLY valid JSON, no markdown fences or extra text.',
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.15,
                top_p: 0.8,
                max_tokens: 8192,
                stream: false,
            });

            const options: https.RequestOptions = {
                hostname: 'api.groq.com',
                path: '/openai/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        // Extract error message from Groq response
                        let errMsg = `Groq API ${res.statusCode}`;
                        try {
                            const errJson = JSON.parse(data);
                            errMsg += `: ${errJson?.error?.message || data.substring(0, 300)}`;
                        } catch {
                            errMsg += `: ${data.substring(0, 300)}`;
                        }
                        reject(new Error(errMsg));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const text = json?.choices?.[0]?.message?.content || '';
                        if (!text) {
                            reject(new Error('Empty response from Groq'));
                            return;
                        }
                        resolve(text);
                    } catch (e) {
                        reject(new Error(`Failed to parse Groq response: ${e}`));
                    }
                });
            });

            req.on('error', (e: Error) => reject(e));
            req.setTimeout(90000, () => { // 90s timeout — Groq is fast but large prompts need time
                req.destroy();
                reject(new Error('Groq API timeout (90s)'));
            });

            req.write(body);
            req.end();
        });
    }

    // ── Response Parser ─────────────────────────────────────

    private parseAIResponse(response: string): ReviewIssue[] {
        try {
            let cleaned = response.trim();
            // Strip markdown code fences if present
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
            }

            const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
            if (!jsonMatch) { return []; }

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) { return []; }

            return parsed
                .filter((item: any) => item && item.message)
                .map((item: any, idx: number) => ({
                    id: `ai-${item.file || 'unknown'}-${item.line || idx}-${idx}`,
                    file: item.file || 'unknown',
                    line: typeof item.line === 'number' ? item.line : 0,
                    severity: this.normalizeSeverity(item.severity),
                    category: this.normalizeCategory(item.category),
                    message: item.message,
                    snippet: item.snippet || undefined,
                    suggestion: item.suggestion || undefined,
                }));
        } catch (e) {
            console.warn('Failed to parse AI response:', e);
            return [];
        }
    }

    // ── Normalizers ─────────────────────────────────────────

    private normalizeSeverity(s: string): 'error' | 'warning' | 'info' | 'suggestion' {
        const map: Record<string, 'error' | 'warning' | 'info' | 'suggestion'> = {
            error: 'error', critical: 'error', high: 'error',
            warning: 'warning', warn: 'warning', medium: 'warning',
            info: 'info', low: 'info', information: 'info',
            suggestion: 'suggestion', hint: 'suggestion', enhancement: 'suggestion',
        };
        return map[(s || '').toLowerCase()] || 'info';
    }

    private normalizeCategory(c: string): ReviewCategory {
        const map: Record<string, ReviewCategory> = {
            'security': 'security', 'performance': 'performance',
            'error-handling': 'error-handling', 'error handling': 'error-handling',
            'best-practice': 'best-practice', 'best-practices': 'best-practice',
            'best practice': 'best-practice', 'complexity': 'complexity',
            'naming': 'naming', 'debug-statement': 'debug-statement',
            'debug': 'debug-statement', 'debug-statements': 'debug-statement',
            'todo-comment': 'todo-comment', 'todo': 'todo-comment',
            'large-file': 'large-file', 'merge-conflict': 'merge-conflict',
            'duplicate-code': 'duplicate-code', 'code-quality': 'best-practice',
        };
        return map[(c || '').toLowerCase()] || 'best-practice';
    }

    private buildSummary(issues: ReviewIssue[], totalFiles: number): ReviewSummary {
        return {
            totalFiles,
            totalIssues: issues.length,
            errors: issues.filter(i => i.severity === 'error').length,
            warnings: issues.filter(i => i.severity === 'warning').length,
            info: issues.filter(i => i.severity === 'info').length,
            suggestions: issues.filter(i => i.severity === 'suggestion').length,
        };
    }

    /** Verify the API key works by making a tiny test call */
    async verifyApiKey(): Promise<boolean> {
        try {
            const response = await this.callGroq('Respond with exactly: {"status":"ok"}');
            return response.includes('ok');
        } catch {
            return false;
        }
    }
}
