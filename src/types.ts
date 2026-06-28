// Type definitions for PR Code Reviewer

export interface PullRequest {
    number: number;
    title: string;
    body: string;
    state: string;
    html_url: string;
    head: {
        ref: string;  // feature branch name
        sha: string;
        repo: {
            full_name: string;
        };
    };
    base: {
        ref: string;  // target branch (usually main)
        sha: string;
    };
    user: {
        login: string;
        avatar_url: string;
    };
    created_at: string;
    updated_at: string;
    mergeable: boolean | null;
    additions: number;
    deletions: number;
    changed_files: number;
}

export interface PRFile {
    sha: string;
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    blob_url: string;
    raw_url: string;
    contents_url: string;
    previous_filename?: string;
}

export interface ReviewIssue {
    id: string;
    file: string;
    line: number;
    endLine?: number;
    severity: 'error' | 'warning' | 'info' | 'suggestion';
    category: ReviewCategory;
    message: string;
    snippet?: string;
    suggestion?: string;
}

export type ReviewCategory =
    | 'large-file'
    | 'debug-statement'
    | 'todo-comment'
    | 'security'
    | 'complexity'
    | 'naming'
    | 'duplicate-code'
    | 'merge-conflict'
    | 'best-practice'
    | 'error-handling'
    | 'performance';

export interface ReviewResult {
    prNumber: number;
    prTitle: string;
    branchName: string;
    timestamp: string;
    summary: ReviewSummary;
    issues: ReviewIssue[];
    files: FileReviewResult[];
    status: 'pass' | 'warn' | 'fail';
}

export interface ReviewSummary {
    totalFiles: number;
    totalIssues: number;
    errors: number;
    warnings: number;
    info: number;
    suggestions: number;
}

export interface FileReviewResult {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    issues: ReviewIssue[];
}

export interface WebhookEvent {
    action: string;
    number: number;
    pull_request: PullRequest;
    repository: {
        full_name: string;
        name: string;
        owner: {
            login: string;
        };
    };
    sender: {
        login: string;
    };
}

export interface ExtensionConfig {
    githubToken: string;
    webhookPort: number;
    webhookSecret: string;
    autoReviewOnPR: boolean;
    owner: string;
    repo: string;
    reviewChecks: ReviewChecksConfig;
    maxFileSizeKB: number;
}

export interface ReviewChecksConfig {
    largeFiles: boolean;
    debugStatements: boolean;
    todoComments: boolean;
    securityPatterns: boolean;
    codeComplexity: boolean;
    namingConventions: boolean;
    duplicateCode: boolean;
    mergeConflicts: boolean;
}
