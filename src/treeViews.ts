import * as vscode from 'vscode';
import { PullRequest, ReviewResult, ReviewIssue, FileReviewResult } from './types';

// ─── Pull Requests Tree Provider ──────────────────────────

export class PullRequestTreeProvider implements vscode.TreeDataProvider<PRTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PRTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private pullRequests: PullRequest[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setPullRequests(prs: PullRequest[]): void {
        this.pullRequests = prs;
        this.refresh();
    }

    getTreeItem(element: PRTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PRTreeItem): PRTreeItem[] {
        if (!element) {
            return this.pullRequests.map(pr => {
                const item = new PRTreeItem(
                    `#${pr.number} ${pr.title}`,
                    vscode.TreeItemCollapsibleState.None,
                    'pullRequest'
                );
                item.description = `${pr.head.ref} → ${pr.base.ref}`;
                item.tooltip = new vscode.MarkdownString(
                    `**${pr.title}**\n\n` +
                    `Branch: \`${pr.head.ref}\` → \`${pr.base.ref}\`\n\n` +
                    `Author: ${pr.user.login}\n\n` +
                    `+${pr.additions} / -${pr.deletions} (${pr.changed_files} files)`
                );
                item.iconPath = new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('charts.green'));
                item.command = {
                    command: 'prCodeReviewer.reviewCurrentPR',
                    title: 'Review PR',
                    arguments: [pr.number],
                };
                item.contextValue = 'pullRequest';
                return item;
            });
        }
        return [];
    }
}

// ─── Review Results Tree Provider ─────────────────────────

export class ReviewResultsTreeProvider implements vscode.TreeDataProvider<PRTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PRTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private reviewResult: ReviewResult | null = null;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setReviewResult(result: ReviewResult): void {
        this.reviewResult = result;
        this.refresh();
    }

    clear(): void {
        this.reviewResult = null;
        this.refresh();
    }

    getTreeItem(element: PRTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PRTreeItem): PRTreeItem[] {
        if (!this.reviewResult) {
            return [];
        }

        // Root level: summary + file list
        if (!element) {
            const items: PRTreeItem[] = [];

            // Status badge
            const statusIcon = this.getStatusIcon(this.reviewResult.status);
            const statusItem = new PRTreeItem(
                `Review: ${this.reviewResult.status.toUpperCase()}`,
                vscode.TreeItemCollapsibleState.None,
                'reviewStatus'
            );
            statusItem.iconPath = statusIcon;
            statusItem.description = `PR #${this.reviewResult.prNumber} — ${this.reviewResult.branchName}`;
            items.push(statusItem);

            // Summary
            const summary = this.reviewResult.summary;
            const summaryItem = new PRTreeItem(
                `${summary.totalIssues} issues found`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'summary'
            );
            summaryItem.iconPath = new vscode.ThemeIcon('checklist');
            summaryItem.description = `${summary.errors} errors, ${summary.warnings} warnings`;
            items.push(summaryItem);

            // Files with issues
            for (const fileResult of this.reviewResult.files) {
                if (fileResult.issues.length === 0 && fileResult.status === 'removed') { continue; }

                const fileItem = new PRTreeItem(
                    fileResult.filename.split('/').pop() || fileResult.filename,
                    fileResult.issues.length > 0
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.None,
                    'file'
                );
                fileItem.description = fileResult.issues.length > 0
                    ? `${fileResult.issues.length} issues`
                    : '✓ No issues';
                fileItem.tooltip = `${fileResult.filename}\n+${fileResult.additions} / -${fileResult.deletions}`;
                fileItem.iconPath = fileResult.issues.length > 0
                    ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
                    : new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
                fileItem.resourceUri = vscode.Uri.parse(`review://${fileResult.filename}`);
                (fileItem as any).__fileResult = fileResult;
                items.push(fileItem);
            }

            return items;
        }

        // Summary children
        if (element.contextValue === 'summary') {
            const s = this.reviewResult.summary;
            return [
                this.createCountItem('Errors', s.errors, 'error'),
                this.createCountItem('Warnings', s.warnings, 'warning'),
                this.createCountItem('Info', s.info, 'info'),
                this.createCountItem('Suggestions', s.suggestions, 'lightbulb'),
            ];
        }

        // File children (individual issues)
        if (element.contextValue === 'file') {
            const fileResult: FileReviewResult = (element as any).__fileResult;
            if (!fileResult) { return []; }

            return fileResult.issues.map(issue => {
                const issueItem = new PRTreeItem(
                    issue.message,
                    vscode.TreeItemCollapsibleState.None,
                    'issue'
                );
                issueItem.description = `Line ${issue.line}`;
                issueItem.tooltip = new vscode.MarkdownString(
                    `**${issue.severity.toUpperCase()}** — ${issue.category}\n\n` +
                    `${issue.message}\n\n` +
                    (issue.snippet ? `\`\`\`\n${issue.snippet}\n\`\`\`\n\n` : '') +
                    (issue.suggestion ? `💡 ${issue.suggestion}` : '')
                );
                issueItem.iconPath = this.getSeverityIcon(issue.severity);
                return issueItem;
            });
        }

        return [];
    }

    private createCountItem(label: string, count: number, icon: string): PRTreeItem {
        const item = new PRTreeItem(
            `${label}: ${count}`,
            vscode.TreeItemCollapsibleState.None,
            'count'
        );
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
    }

    private getStatusIcon(status: string): vscode.ThemeIcon {
        switch (status) {
            case 'pass': return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'warn': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            case 'fail': return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
            default: return new vscode.ThemeIcon('question');
        }
    }

    private getSeverityIcon(severity: string): vscode.ThemeIcon {
        switch (severity) {
            case 'error': return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
            case 'warning': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            case 'info': return new vscode.ThemeIcon('info', new vscode.ThemeColor('list.deemphasizedForeground'));
            case 'suggestion': return new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.yellow'));
            default: return new vscode.ThemeIcon('circle-outline');
        }
    }
}

// ─── Webhook Status Tree Provider ─────────────────────────

export class WebhookStatusTreeProvider implements vscode.TreeDataProvider<PRTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PRTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private running = false;
    private port = 0;
    private eventLog: string[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setStatus(running: boolean, port: number): void {
        this.running = running;
        this.port = port;
        this.refresh();
    }

    addEvent(event: string): void {
        this.eventLog.unshift(`[${new Date().toLocaleTimeString()}] ${event}`);
        if (this.eventLog.length > 20) {
            this.eventLog = this.eventLog.slice(0, 20);
        }
        this.refresh();
    }

    getTreeItem(element: PRTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PRTreeItem): PRTreeItem[] {
        if (!element) {
            const items: PRTreeItem[] = [];

            // Status
            const statusItem = new PRTreeItem(
                this.running ? 'Server Running' : 'Server Stopped',
                vscode.TreeItemCollapsibleState.None,
                'status'
            );
            statusItem.iconPath = this.running
                ? new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('charts.green'))
                : new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('list.errorForeground'));
            statusItem.description = this.running ? `Port ${this.port}` : '';
            items.push(statusItem);

            // Event log
            if (this.eventLog.length > 0) {
                const logItem = new PRTreeItem(
                    'Recent Events',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'eventLog'
                );
                logItem.iconPath = new vscode.ThemeIcon('history');
                logItem.description = `${this.eventLog.length} events`;
                items.push(logItem);
            }

            return items;
        }

        if (element.contextValue === 'eventLog') {
            return this.eventLog.map(e => {
                const item = new PRTreeItem(e, vscode.TreeItemCollapsibleState.None, 'event');
                item.iconPath = new vscode.ThemeIcon('circle-filled');
                return item;
            });
        }

        return [];
    }
}

// ─── Tree Item ────────────────────────────────────────────

export class PRTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        contextValue: string
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
    }
}
