import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';
import { PullRequest, PRFile } from './types';

/**
 * GitHub API service for interacting with pull requests,
 * branches, and repository data.
 */
export class GitHubService {
    private octokit: Octokit;
    private owner: string;
    private repo: string;

    constructor(token: string, owner: string, repo: string) {
        this.octokit = new Octokit({ auth: token });
        this.owner = owner;
        this.repo = repo;
    }

    /**
     * Update the owner/repo context.
     */
    setRepo(owner: string, repo: string): void {
        this.owner = owner;
        this.repo = repo;
    }

    /**
     * Verify the token and connectivity.
     */
    async verifyConnection(): Promise<boolean> {
        try {
            await this.octokit.rest.users.getAuthenticated();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * List open pull requests.
     */
    async listOpenPullRequests(): Promise<PullRequest[]> {
        const { data } = await this.octokit.rest.pulls.list({
            owner: this.owner,
            repo: this.repo,
            state: 'open',
            sort: 'updated',
            direction: 'desc',
            per_page: 30,
        });
        return data as unknown as PullRequest[];
    }

    /**
     * Get a specific pull request by number.
     */
    async getPullRequest(prNumber: number): Promise<PullRequest> {
        const { data } = await this.octokit.rest.pulls.get({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
        });
        return data as unknown as PullRequest;
    }

    /**
     * Get files changed in a pull request.
     */
    async getPullRequestFiles(prNumber: number): Promise<PRFile[]> {
        const files: PRFile[] = [];
        let page = 1;

        while (true) {
            const { data } = await this.octokit.rest.pulls.listFiles({
                owner: this.owner,
                repo: this.repo,
                pull_number: prNumber,
                per_page: 100,
                page,
            });

            if (data.length === 0) { break; }
            files.push(...(data as unknown as PRFile[]));
            if (data.length < 100) { break; }
            page++;
        }

        return files;
    }

    /**
     * Get file content from a specific branch/ref.
     */
    async getFileContent(path: string, ref: string): Promise<string | null> {
        try {
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.owner,
                repo: this.repo,
                path,
                ref,
            });

            if ('content' in data && data.encoding === 'base64') {
                return Buffer.from(data.content, 'base64').toString('utf-8');
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Get the diff between two branches.
     */
    async compareBranches(base: string, head: string): Promise<any> {
        const { data } = await this.octokit.rest.repos.compareCommits({
            owner: this.owner,
            repo: this.repo,
            base,
            head,
        });
        return data;
    }

    /**
     * Post a review comment on a PR.
     */
    async createReviewComment(
        prNumber: number,
        body: string,
        commitId: string,
        path: string,
        line: number
    ): Promise<void> {
        try {
            await this.octokit.rest.pulls.createReviewComment({
                owner: this.owner,
                repo: this.repo,
                pull_number: prNumber,
                body,
                commit_id: commitId,
                path,
                line,
                side: 'RIGHT',
            });
        } catch (err: any) {
            console.warn(`Failed to post comment on ${path}:${line}: ${err.message}`);
        }
    }

    /**
     * Submit a full PR review (approve, request changes, or comment).
     */
    async submitReview(
        prNumber: number,
        event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
        body: string
    ): Promise<void> {
        await this.octokit.rest.pulls.createReview({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            event,
            body,
        });
    }

    /**
     * Post a general comment on the PR (issue comment).
     */
    async postPRComment(prNumber: number, body: string): Promise<void> {
        await this.octokit.rest.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
            body,
        });
    }

    /**
     * Create a commit status check.
     */
    async createCommitStatus(
        sha: string,
        state: 'error' | 'failure' | 'pending' | 'success',
        description: string,
        targetUrl?: string
    ): Promise<void> {
        await this.octokit.rest.repos.createCommitStatus({
            owner: this.owner,
            repo: this.repo,
            sha,
            state,
            description,
            context: 'PR Code Reviewer',
            target_url: targetUrl,
        });
    }

    /**
     * Get commits for a PR.
     */
    async getPRCommits(prNumber: number): Promise<any[]> {
        const { data } = await this.octokit.rest.pulls.listCommits({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: 100,
        });
        return data;
    }

    /**
     * Get repository branch protection rules.
     */
    async getBranchProtection(branch: string): Promise<any> {
        try {
            const { data } = await this.octokit.rest.repos.getBranchProtection({
                owner: this.owner,
                repo: this.repo,
                branch,
            });
            return data;
        } catch {
            return null;
        }
    }
}
