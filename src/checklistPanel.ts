import * as vscode from 'vscode';
import { ReviewChecksConfig } from './types';
import { AIReviewService } from './aiReviewService';

/**
 * Interactive settings panel where developers can:
 * 1. Toggle review categories for the AI to focus on
 * 2. Add custom review rules (sent as prompts to the AI)
 * 3. Configure Groq API key
 * 4. See all API endpoints
 */
export class ChecklistPanel {
    public static currentPanel: ChecklistPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private _onChecklistChanged = new vscode.EventEmitter<ReviewChecksConfig>();
    public readonly onChecklistChanged = this._onChecklistChanged.event;
    private _onRunReview = new vscode.EventEmitter<void>();
    public readonly onRunReview = this._onRunReview.event;

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveChecklist':
                        await this.saveChecklist(message.checks);
                        break;
                    case 'saveCustomRules':
                        await this.saveCustomRules(message.rules);
                        break;
                    case 'runReview':
                        this._onRunReview.fire();
                        break;
                    case 'saveAIKey':
                        await this.saveAIKey(message.key);
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(): ChecklistPanel {
        const column = vscode.ViewColumn.One;
        if (ChecklistPanel.currentPanel) {
            ChecklistPanel.currentPanel.panel.reveal(column);
            ChecklistPanel.currentPanel.updateContent();
            return ChecklistPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            'prReviewChecklist', '⚙️ Review Settings', column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ChecklistPanel.currentPanel = new ChecklistPanel(panel);
        ChecklistPanel.currentPanel.updateContent();
        return ChecklistPanel.currentPanel;
    }

    public updateContent(): void {
        const config = vscode.workspace.getConfiguration('prCodeReviewer');
        const checks = config.get<ReviewChecksConfig>('reviewChecks', {
            largeFiles: true, debugStatements: true, todoComments: true,
            securityPatterns: true, codeComplexity: true, namingConventions: true,
            duplicateCode: true, mergeConflicts: true,
        });
        const customRules = config.get<string[]>('customReviewRules', []);
        const aiApiKey = config.get<string>('geminiApiKey', '');
        const webhookPort = config.get<number>('webhookPort', 7890);
        const endpoints = AIReviewService.getEndpointInfo();
        endpoints.webhookEndpoint = `http://localhost:${webhookPort}/webhook`;
        this.panel.webview.html = this.getHtml(checks, customRules, !!aiApiKey, endpoints);
    }

    private async saveChecklist(checks: ReviewChecksConfig): Promise<void> {
        await vscode.workspace.getConfiguration('prCodeReviewer').update('reviewChecks', checks, true);
        this._onChecklistChanged.fire(checks);
        vscode.window.showInformationMessage('✔ Review categories updated.');
    }

    private async saveCustomRules(rules: string[]): Promise<void> {
        await vscode.workspace.getConfiguration('prCodeReviewer').update('customReviewRules', rules, true);
        vscode.window.showInformationMessage(`✔ ${rules.length} custom rule(s) saved.`);
    }

    private async saveAIKey(key: string): Promise<void> {
        await vscode.workspace.getConfiguration('prCodeReviewer').update('geminiApiKey', key, true);
        if (key) {
            vscode.window.showInformationMessage('🔑 Verifying Groq API key...');
            const ai = new AIReviewService(key);
            const valid = await ai.verifyApiKey();
            vscode.window.showInformationMessage(valid
                ? '✅ Groq API key verified! AI review is ready.'
                : '⚠️ Could not verify API key. Double-check it.');
        } else {
            vscode.window.showInformationMessage('API key removed.');
        }
        this.updateContent();
    }

    private getHtml(
        checks: ReviewChecksConfig,
        customRules: string[],
        hasAIKey: boolean,
        endpoints: ReturnType<typeof AIReviewService.getEndpointInfo>
    ): string {
        const rulesJson = JSON.stringify(customRules);

        const checkItems: { key: string; icon: string; name: string; desc: string }[] = [
            { key: 'securityPatterns', icon: '🔒', name: 'Security Vulnerabilities', desc: 'SQL injection, XSS, hardcoded secrets, eval()' },
            { key: 'debugStatements', icon: '🐛', name: 'Debug Statements', desc: 'console.log, print, debugger, etc.' },
            { key: 'codeComplexity', icon: '🧩', name: 'Code Complexity', desc: 'Deep nesting, long functions, high cyclomatic complexity' },
            { key: 'todoComments', icon: '📌', name: 'TODO / FIXME Comments', desc: 'Unresolved TODO, FIXME, HACK, TEMP' },
            { key: 'namingConventions', icon: '🏷️', name: 'Naming Conventions', desc: 'Poor variable names, inconsistent casing' },
            { key: 'mergeConflicts', icon: '⚡', name: 'Merge Conflicts', desc: 'Leftover <<<<<<< conflict markers' },
            { key: 'largeFiles', icon: '📦', name: 'Large Changesets', desc: 'Files with excessive additions/deletions' },
            { key: 'duplicateCode', icon: '📋', name: 'Duplicate Code', desc: 'Repeated patterns, copy-paste code' },
        ];

        const checksHtml = checkItems.map(c => {
            const enabled = (checks as any)[c.key] ?? true;
            return `
                <div class="check-row ${enabled ? 'active' : ''}" data-key="${c.key}" onclick="toggleCheck(this)">
                    <div class="toggle-track"><div class="toggle-thumb"></div></div>
                    <span class="check-icon">${c.icon}</span>
                    <div class="check-text">
                        <div class="check-name">${c.name}</div>
                        <div class="check-desc">${c.desc}</div>
                    </div>
                </div>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Review Settings</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
    --bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);
    --card:var(--vscode-sideBar-background);--border:var(--vscode-panel-border);
    --input-bg:var(--vscode-input-background);--input-fg:var(--vscode-input-foreground);
    --input-border:var(--vscode-input-border);--btn:var(--vscode-button-background);
    --btn-fg:var(--vscode-button-foreground);--btn-hover:var(--vscode-button-hoverBackground);
    --hover:var(--vscode-list-hoverBackground);--font:var(--vscode-font-family);
    --mono:var(--vscode-editor-font-family);
    --green:#10b981;--red:#ef4444;--blue:#3b82f6;
}
body{font-family:var(--font);color:var(--fg);background:var(--bg);padding:24px 28px;line-height:1.6;max-width:860px;margin:0 auto}

h1{font-size:1.4em;font-weight:800;margin-bottom:4px}
.subtitle{opacity:.55;font-size:.88em;margin-bottom:28px}

/* ─── Sections ─── */
.section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin-bottom:20px}
.section h2{font-size:1.05em;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.section .hint{font-size:.82em;opacity:.5;margin-bottom:16px}

/* ─── Toggle Rows ─── */
.check-row{
    display:flex;align-items:center;gap:12px;
    padding:10px 14px;border:1px solid var(--border);border-radius:8px;
    margin-bottom:8px;cursor:pointer;transition:all .2s;
}
.check-row:hover{background:var(--hover)}
.check-row.active{border-color:var(--green);background:rgba(16,185,129,.05)}

.toggle-track{
    width:38px;height:20px;border-radius:10px;background:#555;
    position:relative;transition:background .2s;flex-shrink:0;
}
.check-row.active .toggle-track{background:var(--green)}
.toggle-thumb{
    width:16px;height:16px;border-radius:50%;background:#fff;
    position:absolute;top:2px;left:2px;transition:transform .2s;
}
.check-row.active .toggle-thumb{transform:translateX(18px)}
.check-icon{font-size:1.15em;flex-shrink:0}
.check-text{flex:1;min-width:0}
.check-name{font-weight:600;font-size:.88em}
.check-desc{font-size:.76em;opacity:.5}

/* ─── Custom Rules ─── */
.rules-list{list-style:none;margin-bottom:12px}
.rules-list li{
    display:flex;align-items:center;justify-content:space-between;
    padding:9px 14px;border:1px solid var(--border);border-radius:6px;
    margin-bottom:6px;font-size:.88em;animation:fadeIn .2s;
}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.rule-del{
    background:transparent;border:none;color:var(--red);cursor:pointer;
    font-size:1em;padding:0 4px;opacity:.7;transition:opacity .15s;
}
.rule-del:hover{opacity:1}
.add-row{display:flex;gap:8px}
.add-row input{
    flex:1;padding:9px 14px;background:var(--input-bg);color:var(--input-fg);
    border:1px solid var(--input-border);border-radius:6px;font-size:.88em;
}
.add-row input:focus{outline:none;border-color:var(--blue)}

/* ─── API Grid ─── */
.api-grid{display:grid;grid-template-columns:120px 1fr;gap:5px 14px;font-size:.84em}
.api-label{font-weight:600;opacity:.6}
.api-value{font-family:var(--mono);color:#58a6ff;word-break:break-all}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.on{background:var(--green)}
.dot.off{background:#6b7280}

/* ─── AI Key Input ─── */
.key-row{display:flex;gap:8px;margin-top:14px}
.key-row input{
    flex:1;padding:9px 14px;background:var(--input-bg);color:var(--input-fg);
    border:1px solid var(--input-border);border-radius:6px;font-size:.88em;
}

/* ─── Buttons ─── */
.btn{
    padding:9px 22px;border:none;border-radius:8px;cursor:pointer;
    font-size:.88em;font-weight:700;transition:all .15s;display:inline-flex;align-items:center;gap:6px;
}
.btn:hover{transform:translateY(-1px)}
.btn-primary{background:var(--btn);color:var(--btn-fg)}
.btn-primary:hover{background:var(--btn-hover)}
.btn-green{background:var(--green);color:#fff}
.btn-red{background:var(--red);color:#fff}
.btn-sm{padding:7px 14px;font-size:.82em}

.actions-bar{display:flex;gap:12px;margin-top:24px;justify-content:center;flex-wrap:wrap}
.sep{border-top:1px solid var(--border);margin:14px 0}
</style>
</head>
<body>

<h1>⚙️ Review Checklist & Settings</h1>
<p class="subtitle">Configure what the AI reviewer checks. Custom rules are sent directly to the LLM as additional instructions.</p>

<!-- Categories -->
<div class="section">
    <h2>📋 Review Categories</h2>
    <p class="hint">Toggle categories ON/OFF. The AI will focus on enabled categories during review.</p>
    ${checksHtml}
</div>

<!-- Custom Rules -->
<div class="section">
    <h2>✏️ Custom Review Rules</h2>
    <p class="hint">Add your own rules — these are injected directly into the AI prompt as mandatory checks.</p>
    <ul class="rules-list" id="ruleList"></ul>
    <div class="add-row">
        <input type="text" id="ruleInput" placeholder='e.g. "Ensure all API routes have authentication middleware"' />
        <button class="btn btn-sm btn-green" onclick="addRule()">+ Add</button>
    </div>
</div>

<!-- AI Config -->
<div class="section">
    <h2>🤖 AI Engine Configuration</h2>
    <div class="api-grid">
        <span class="api-label">LLM Model</span>
        <span class="api-value">${endpoints.llmName}</span>
        <span class="api-label">Model ID</span>
        <span class="api-value">${endpoints.model}</span>
        <span class="api-label">Provider</span>
        <span class="api-value">${endpoints.provider}</span>
        <span class="api-label">Status</span>
        <span><span class="dot ${hasAIKey ? 'on' : 'off'}"></span>${hasAIKey ? 'Connected & Ready' : 'No API key — add one below'}</span>
    </div>
    <div class="sep"></div>
    <p style="font-size:.84em;opacity:.6;">
        Enter your Groq API key.
        <a href="https://console.groq.com/keys" style="color:#58a6ff;">Get a free key →</a>
    </p>
    <div class="key-row">
        <input type="password" id="aiKey" placeholder="${hasAIKey ? '••••••••••••••••••' : 'Paste Groq API key'}" />
        <button class="btn btn-sm btn-primary" onclick="saveKey()">Save</button>
        ${hasAIKey ? '<button class="btn btn-sm btn-red" onclick="delKey()">Remove</button>' : ''}
    </div>
</div>

<!-- Endpoints -->
<div class="section">
    <h2>🔗 API Endpoints</h2>
    <div class="api-grid">
        <span class="api-label">GitHub API</span>
        <span class="api-value">${endpoints.githubApi}</span>
        <span class="api-label">Groq API</span>
        <span class="api-value">${endpoints.endpoint}</span>
        <span class="api-label">Webhook</span>
        <span class="api-value">${endpoints.webhookEndpoint}</span>
        <span class="api-label">Health</span>
        <span class="api-value">GET /health</span>
    </div>
</div>

<div class="actions-bar">
    <button class="btn btn-primary" onclick="saveAll()">💾 Save Settings</button>
    <button class="btn btn-green" onclick="runReview()">▶ Run Review Now</button>
</div>

<script>
const vscode = acquireVsCodeApi();
let rules = ${rulesJson};

function renderRules(){
    const ul = document.getElementById('ruleList');
    ul.innerHTML = rules.map((r,i) =>
        '<li><span>'+esc(r)+'</span><button class="rule-del" onclick="delRule('+i+')">✕</button></li>'
    ).join('');
}
function addRule(){
    const inp = document.getElementById('ruleInput');
    const v = inp.value.trim();
    if(v){rules.push(v);inp.value='';renderRules();vscode.postMessage({command:'saveCustomRules',rules});}
}
function delRule(i){rules.splice(i,1);renderRules();vscode.postMessage({command:'saveCustomRules',rules});}

function toggleCheck(el){
    el.classList.toggle('active');
    saveChecks();
}
function saveChecks(){
    const checks={};
    document.querySelectorAll('.check-row').forEach(r=>{checks[r.dataset.key]=r.classList.contains('active');});
    vscode.postMessage({command:'saveChecklist',checks});
}
function saveKey(){vscode.postMessage({command:'saveAIKey',key:document.getElementById('aiKey').value.trim()});}
function delKey(){vscode.postMessage({command:'saveAIKey',key:''});}
function saveAll(){saveChecks();vscode.postMessage({command:'saveCustomRules',rules});}
function runReview(){vscode.postMessage({command:'runReview'});}
function esc(t){const d=document.createElement('div');d.appendChild(document.createTextNode(t));return d.innerHTML;}
document.getElementById('ruleInput').addEventListener('keypress',e=>{if(e.key==='Enter')addRule();});
renderRules();
</script>
</body>
</html>`;
    }

    public dispose(): void {
        ChecklistPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}
