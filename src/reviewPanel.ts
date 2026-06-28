import * as vscode from 'vscode';
import { ReviewResult } from './types';
import { AIReviewService } from './aiReviewService';

/**
 * WebView panel — polished, modern review report with:
 * - Glassmorphism cards
 * - Animated severity counters
 * - Expandable file sections with smooth transitions
 * - AI/LLM info footer
 * - Re-check button
 */
export class ReviewPanel {
    public static currentPanel: ReviewPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private _onRecheck = new vscode.EventEmitter<number>();
    public readonly onRecheck = this._onRecheck.event;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message) => {
                if (message.command === 'recheck') {
                    this._onRecheck.fire(message.prNumber);
                } else if (message.command === 'openFile') {
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri): ReviewPanel {
        const column = vscode.ViewColumn.Beside;
        if (ReviewPanel.currentPanel) {
            ReviewPanel.currentPanel.panel.reveal(column);
            return ReviewPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            'prCodeReviewResult', 'PR Code Review', column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
        );
        ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri);
        return ReviewPanel.currentPanel;
    }

    public showReview(result: ReviewResult): void {
        this.panel.title = `Review: PR #${result.prNumber}`;
        const endpoints = AIReviewService.getEndpointInfo();
        this.panel.webview.html = this.getHtml(result, endpoints);
    }

    public showLoading(prNumber: number): void {
        this.panel.title = `Reviewing PR #${prNumber}...`;
        this.panel.webview.html = this.getLoadingHtml(prNumber);
    }

    private getHtml(result: ReviewResult, endpoints: ReturnType<typeof AIReviewService.getEndpointInfo>): string {
        const statusColor = result.status === 'pass' ? '#10b981' : result.status === 'warn' ? '#f59e0b' : '#ef4444';
        const statusLabel = result.status === 'pass' ? 'PASSED' : result.status === 'warn' ? 'WARNINGS' : 'FAILED';
        const statusIcon = result.status === 'pass' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';

        const fileRows = result.files
            .filter(f => f.status !== 'removed')
            .map((f, idx) => {
                const hasErrors = f.issues.some(i => i.severity === 'error');
                const hasWarnings = f.issues.some(i => i.severity === 'warning');
                const badgeClass = hasErrors ? 'badge-error' : hasWarnings ? 'badge-warning' : 'badge-pass';
                const issueCount = f.issues.length;

                const issuesHtml = f.issues.length > 0
                    ? f.issues.map(issue => `
                        <div class="issue issue-${issue.severity}">
                            <div class="issue-header">
                                <span class="severity-pill severity-${issue.severity}">${this.severityIcon(issue.severity)} ${issue.severity.toUpperCase()}</span>
                                <span class="issue-meta">Line ${issue.line} · ${issue.category}</span>
                            </div>
                            <p class="issue-msg">${this.escapeHtml(issue.message)}</p>
                            ${issue.snippet ? `<pre class="code-block"><code>${this.escapeHtml(issue.snippet)}</code></pre>` : ''}
                            ${issue.suggestion ? `<div class="suggestion">💡 <strong>Fix:</strong> ${this.escapeHtml(issue.suggestion)}</div>` : ''}
                        </div>
                    `).join('')
                    : '<p class="no-issues">✓ No issues found</p>';

                return `
                    <div class="file-card" data-idx="${idx}">
                        <div class="file-header" onclick="toggle(${idx})">
                            <div class="file-info">
                                <span class="file-icon">${this.fileIcon(f.filename)}</span>
                                <span class="file-name">${this.escapeHtml(f.filename)}</span>
                            </div>
                            <div class="file-badges">
                                <span class="stat-add">+${f.additions}</span>
                                <span class="stat-del">-${f.deletions}</span>
                                <span class="badge ${badgeClass}">${issueCount}</span>
                                <span class="chevron">▶</span>
                            </div>
                        </div>
                        <div class="file-body">${issuesHtml}</div>
                    </div>`;
            }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Review</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
    --bg:var(--vscode-editor-background);
    --fg:var(--vscode-editor-foreground);
    --card:var(--vscode-sideBar-background);
    --border:var(--vscode-panel-border);
    --hover:var(--vscode-list-hoverBackground);
    --font:var(--vscode-font-family);
    --mono:var(--vscode-editor-font-family);
    --btn:var(--vscode-button-background);
    --btn-fg:var(--vscode-button-foreground);
    --btn-hover:var(--vscode-button-hoverBackground);
}
body{font-family:var(--font);color:var(--fg);background:var(--bg);padding:24px 28px;line-height:1.65}

/* ─── Header ─── */
.top-bar{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;gap:16px;flex-wrap:wrap}
.top-bar h1{font-size:1.35em;font-weight:700;line-height:1.3}
.top-bar h1 span.pr-num{opacity:.5;font-weight:400}
.status-chip{
    display:inline-flex;align-items:center;gap:6px;
    padding:7px 18px;border-radius:24px;font-weight:700;font-size:.85em;
    color:#fff;background:${statusColor};
    box-shadow:0 2px 12px ${statusColor}44;
    white-space:nowrap;
}

/* ─── Stats Grid ─── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.stat-card{
    background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 18px;
    transition:transform .15s,box-shadow .15s;
}
.stat-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(0,0,0,.15)}
.stat-card .label{font-size:.72em;text-transform:uppercase;letter-spacing:.5px;opacity:.6;margin-bottom:4px}
.stat-card .num{font-size:1.6em;font-weight:800}
.stat-card .num.c-err{color:#ef4444}
.stat-card .num.c-warn{color:#f59e0b}
.stat-card .num.c-info{color:#3b82f6}
.stat-card .num.c-sug{color:#10b981}

/* ─── Severity Pills ─── */
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px}
.pill{padding:6px 14px;border-radius:20px;font-size:.82em;font-weight:600;display:flex;align-items:center;gap:5px}
.pill-err{background:rgba(239,68,68,.12);color:#ef4444}
.pill-warn{background:rgba(245,158,11,.12);color:#f59e0b}
.pill-info{background:rgba(59,130,246,.12);color:#3b82f6}
.pill-sug{background:rgba(16,185,129,.12);color:#10b981}

/* ─── Section Title ─── */
.section-title{font-size:1.05em;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* ─── File Cards ─── */
.file-card{border:1px solid var(--border);border-radius:10px;margin-bottom:10px;overflow:hidden;transition:box-shadow .2s}
.file-card:hover{box-shadow:0 2px 10px rgba(0,0,0,.1)}
.file-header{
    display:flex;justify-content:space-between;align-items:center;
    padding:11px 16px;cursor:pointer;background:var(--card);
    transition:background .15s;
}
.file-header:hover{background:var(--hover)}
.file-info{display:flex;align-items:center;gap:8px;min-width:0}
.file-icon{font-size:1.1em;flex-shrink:0}
.file-name{font-family:var(--mono);font-size:.88em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-badges{display:flex;align-items:center;gap:8px;flex-shrink:0}
.stat-add{color:#10b981;font-size:.82em;font-weight:600}
.stat-del{color:#ef4444;font-size:.82em;font-weight:600}
.badge{padding:2px 9px;border-radius:10px;font-size:.78em;font-weight:700;color:#fff}
.badge-error{background:#ef4444}
.badge-warning{background:#f59e0b;color:#000}
.badge-pass{background:#10b981}
.chevron{font-size:.7em;opacity:.4;transition:transform .25s;display:inline-block}
.file-card.open .chevron{transform:rotate(90deg)}

.file-body{
    max-height:0;overflow:hidden;transition:max-height .35s ease,padding .25s;
    padding:0 16px;border-top:0 solid var(--border);
}
.file-card.open .file-body{
    max-height:3000px;padding:14px 16px;border-top-width:1px;
}

/* ─── Issues ─── */
.issue{
    padding:12px 14px;margin-bottom:10px;border-radius:8px;
    border-left:4px solid;transition:background .15s;
}
.issue:hover{filter:brightness(1.05)}
.issue-error{border-left-color:#ef4444;background:rgba(239,68,68,.04)}
.issue-warning{border-left-color:#f59e0b;background:rgba(245,158,11,.04)}
.issue-info{border-left-color:#3b82f6;background:rgba(59,130,246,.04)}
.issue-suggestion{border-left-color:#10b981;background:rgba(16,185,129,.04)}

.issue-header{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.severity-pill{font-size:.72em;padding:2px 8px;border-radius:4px;font-weight:700;text-transform:uppercase}
.severity-error{background:rgba(239,68,68,.15);color:#ef4444}
.severity-warning{background:rgba(245,158,11,.15);color:#f59e0b}
.severity-info{background:rgba(59,130,246,.15);color:#3b82f6}
.severity-suggestion{background:rgba(16,185,129,.15);color:#10b981}
.issue-meta{font-size:.75em;opacity:.5}
.issue-msg{font-size:.9em;margin-bottom:6px}

.code-block{
    background:var(--vscode-textCodeBlock-background);padding:10px 12px;border-radius:6px;
    overflow-x:auto;font-size:.83em;margin:6px 0;
}
.code-block code{font-family:var(--mono)}

.suggestion{font-size:.85em;padding:8px 12px;border-radius:6px;background:rgba(16,185,129,.06);margin-top:6px;line-height:1.5}
.no-issues{color:#10b981;font-style:italic;padding:8px 0;font-size:.9em}

/* ─── Actions ─── */
.actions{display:flex;gap:12px;margin-top:28px;flex-wrap:wrap}
.btn{
    padding:10px 24px;border:none;border-radius:8px;cursor:pointer;
    font-size:.9em;font-weight:700;transition:all .15s;display:inline-flex;align-items:center;gap:6px;
}
.btn-primary{background:var(--btn);color:var(--btn-fg)}
.btn-primary:hover{background:var(--btn-hover);transform:translateY(-1px)}

/* ─── AI Info Footer ─── */
.ai-footer{
    margin-top:28px;padding:18px 20px;
    background:var(--card);border:1px solid var(--border);border-radius:10px;
}
.ai-footer h3{font-size:.95em;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.api-grid{display:grid;grid-template-columns:120px 1fr;gap:5px 14px;font-size:.83em}
.api-label{opacity:.6;font-weight:600}
.api-value{font-family:var(--mono);color:#58a6ff;word-break:break-all}
.ai-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
.ai-dot.on{background:#10b981}
.ai-dot.off{background:#6b7280}

.timestamp{font-size:.75em;opacity:.35;margin-top:16px;text-align:center}
</style>
</head>
<body>

<div class="top-bar">
    <h1><span class="pr-num">PR #${result.prNumber}:</span> ${this.escapeHtml(result.prTitle)}</h1>
    <span class="status-chip">${statusIcon} ${statusLabel}</span>
</div>

<div class="stats">
    <div class="stat-card">
        <div class="label">Branch</div>
        <div class="num" style="font-size:1em;font-weight:600">${this.escapeHtml(result.branchName)}</div>
    </div>
    <div class="stat-card">
        <div class="label">Files Reviewed</div>
        <div class="num">${result.summary.totalFiles}</div>
    </div>
    <div class="stat-card">
        <div class="label">Total Issues</div>
        <div class="num">${result.summary.totalIssues}</div>
    </div>
    <div class="stat-card">
        <div class="label">Review Engine</div>
        <div class="num" style="font-size:.85em;font-weight:600">🤖 ${AIReviewService.LLM_NAME}</div>
    </div>
</div>

<div class="pills">
    <span class="pill pill-err">🔴 ${result.summary.errors} Errors</span>
    <span class="pill pill-warn">🟡 ${result.summary.warnings} Warnings</span>
    <span class="pill pill-info">🔵 ${result.summary.info} Info</span>
    <span class="pill pill-sug">🟢 ${result.summary.suggestions} Suggestions</span>
</div>

<div class="section-title">📁 Files Changed</div>
${fileRows}

<div class="actions">
    <button class="btn btn-primary" onclick="recheck()">🔄 Re-check Feature Branch</button>
</div>

<div class="ai-footer">
    <h3>🤖 AI Review Engine Info</h3>
    <div class="api-grid">
        <span class="api-label">LLM Model</span>
        <span class="api-value">${endpoints.llmName}</span>
        <span class="api-label">Model ID</span>
        <span class="api-value">${endpoints.model}</span>
        <span class="api-label">Provider</span>
        <span class="api-value">${endpoints.provider}</span>
        <span class="api-label">AI Endpoint</span>
        <span class="api-value">${endpoints.endpoint}</span>
        <span class="api-label">GitHub API</span>
        <span class="api-value">${endpoints.githubApi}</span>
        <span class="api-label">Webhook</span>
        <span class="api-value">${endpoints.webhookEndpoint}</span>
        <span class="api-label">Status</span>
        <span><span class="ai-dot on"></span> Active — Powered by AI</span>
    </div>
</div>

<p class="timestamp">Reviewed at ${new Date(result.timestamp).toLocaleString()} · Powered by ${AIReviewService.LLM_NAME}</p>

<script>
const vscode = acquireVsCodeApi();
function toggle(idx){
    document.querySelector('[data-idx="'+idx+'"]').classList.toggle('open');
}
function recheck(){
    vscode.postMessage({command:'recheck',prNumber:${result.prNumber}});
}
// Auto-expand files with issues
document.querySelectorAll('.file-card').forEach(c=>{
    if(c.querySelector('.issue'))c.classList.add('open');
});
</script>
</body>
</html>`;
    }

    private getLoadingHtml(prNumber: number): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
    font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);
    background:var(--vscode-editor-background);
    display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;
    text-align:center;
}
.loader{position:relative;width:56px;height:56px;margin-bottom:24px}
.loader span{
    position:absolute;width:100%;height:100%;border-radius:50%;
    border:3px solid transparent;border-top-color:var(--vscode-button-background);
}
.loader span:nth-child(1){animation:spin .8s linear infinite}
.loader span:nth-child(2){width:75%;height:75%;top:12.5%;left:12.5%;border-top-color:#f59e0b;animation:spin 1.2s linear infinite reverse}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:1.2em;margin-bottom:8px}
p{opacity:.6;font-size:.9em}
.powered{margin-top:24px;font-size:.78em;opacity:.4}
</style>
</head>
<body>
    <div class="loader"><span></span><span></span></div>
    <h2>Reviewing PR #${prNumber}</h2>
    <p>🤖 Analyzing code with ${AIReviewService.LLM_NAME}...</p>
    <p class="powered">Powered by Groq &amp; Llama 3.3 70B AI</p>
</body>
</html>`;
    }

    private severityIcon(severity: string): string {
        const map: Record<string, string> = { error: '🔴', warning: '🟡', info: '🔵', suggestion: '🟢' };
        return map[severity] || '⚪';
    }

    private fileIcon(filename: string): string {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const icons: Record<string, string> = {
            js: '📜', ts: '📘', jsx: '⚛️', tsx: '⚛️', py: '🐍', java: '☕',
            html: '🌐', css: '🎨', json: '📋', md: '📝', yml: '⚙️', yaml: '⚙️',
            go: '🔷', rs: '🦀', rb: '💎', php: '🐘', sql: '🗃️',
        };
        return icons[ext] || '📄';
    }

    private escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    public dispose(): void {
        ReviewPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}
