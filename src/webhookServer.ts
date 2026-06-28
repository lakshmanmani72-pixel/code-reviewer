import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WebhookEvent } from './types';

/**
 * Local HTTP server to receive GitHub webhook events for pull requests.
 * Listens for PR opened/synchronized/reopened events and triggers reviews.
 */
export class WebhookServer {
    private server: http.Server | null = null;
    private port: number;
    private secret: string;
    private _onPullRequestEvent = new vscode.EventEmitter<WebhookEvent>();
    public readonly onPullRequestEvent = this._onPullRequestEvent.event;
    private _onStatusChange = new vscode.EventEmitter<boolean>();
    public readonly onStatusChange = this._onStatusChange.event;

    constructor(port: number, secret: string) {
        this.port = port;
        this.secret = secret;
    }

    /**
     * Start the webhook listener server.
     */
    async start(): Promise<void> {
        if (this.server) {
            throw new Error('Webhook server is already running.');
        }

        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    vscode.window.showErrorMessage(
                        `Port ${this.port} is already in use. Change the webhook port in settings.`
                    );
                }
                reject(err);
            });

            this.server.listen(this.port, () => {
                this._onStatusChange.fire(true);
                vscode.window.showInformationMessage(
                    `🔗 Webhook server started on port ${this.port}`
                );
                resolve();
            });
        });
    }

    /**
     * Stop the webhook listener server.
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.server = null;
                    this._onStatusChange.fire(false);
                    vscode.window.showInformationMessage('Webhook server stopped.');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    get isRunning(): boolean {
        return this.server !== null;
    }

    /**
     * Handle incoming HTTP requests.
     */
    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Only accept POST requests
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        // Health-check endpoint
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
            return;
        }

        // Only accept webhook endpoint
        if (req.url !== '/webhook' && req.url !== '/') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });

        req.on('end', () => {
            // Validate signature if secret is configured
            if (this.secret) {
                const signature = req.headers['x-hub-signature-256'] as string;
                if (!this.verifySignature(body, signature)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid signature' }));
                    return;
                }
            }

            // Check the event type
            const eventType = req.headers['x-github-event'] as string;
            if (eventType !== 'pull_request') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: `Event '${eventType}' ignored` }));
                return;
            }

            try {
                const payload: WebhookEvent = JSON.parse(body);

                // Only process relevant PR actions
                const relevantActions = ['opened', 'synchronize', 'reopened', 'ready_for_review'];
                if (!relevantActions.includes(payload.action)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: `PR action '${payload.action}' ignored` }));
                    return;
                }

                // Fire the event
                this._onPullRequestEvent.fire(payload);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    message: 'Review triggered',
                    pr: payload.number,
                    action: payload.action,
                }));

                vscode.window.showInformationMessage(
                    `📩 Webhook received: PR #${payload.number} "${payload.pull_request.title}" (${payload.action})`
                );
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
        });
    }

    /**
     * Verify GitHub webhook signature (HMAC SHA-256).
     */
    private verifySignature(payload: string, signature: string): boolean {
        if (!signature) { return false; }
        const hmac = crypto.createHmac('sha256', this.secret);
        const digest = 'sha256=' + hmac.update(payload).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }

    dispose(): void {
        this._onPullRequestEvent.dispose();
        this._onStatusChange.dispose();
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}
