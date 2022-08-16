// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
/* eslint-disable filenames/match-regex */

import { watch } from 'chokidar';
import { readFileSync, existsSync } from 'fs';
import { observe } from 'mobx';
import fetch from 'node-fetch';
import { Log } from 'sarif';
import { authentication, extensions, workspace } from 'vscode';
import { augmentLog } from '../shared';
import '../shared/extension';
import { API, GitExtension, Repository } from './git';
import { driverlessRules } from './loadLogs';
import { Panel } from './panel';
import { isSpinning } from './statusBarItem';
import { Store } from './store';

// Subset of the GitHub API.
export interface AnalysisInfo {
    id: number;
    commit_sha: string;
    created_at: string;
}

let currentLogUri: string | undefined = undefined;

export async function getInitializedGitApi(): Promise<API | undefined> {
    return new Promise(resolve => {
        const gitExtension = extensions.getExtension<GitExtension>('vscode.git')?.exports;
        if (!gitExtension) {
            resolve(undefined);
            return;
        }

        const git = gitExtension.getAPI(1);
        if (git.state !== 'initialized') {
            git.onDidChangeState(async state => {
                if (state === 'initialized') {
                    resolve(git);
                }
            });
        } else {
            resolve(git);
        }
    });
}

export function activateGithubAnalyses(store: Store, panel: Panel) {
    const config = {
        user: '',
        repoName: '',
    };

    (async () => {
        const git = await getInitializedGitApi();
        if (!git) return console.warn('No GitExtension or GitExtension API');

        const repo = git.repositories[0];
        if (!repo) return console.warn('No repo');

        const origin = await repo.getConfig('remote.origin.url');
        const [, user, repoName] = origin.match(/https:\/\/github.com\/([^/]+)\/([^/]+)/) ?? [];
        if (!user || !repoName) return console.warn('No acceptable origin');
        config.user = user;
        config.repoName = repoName.replace('.git', ''); // A repoName may optionally end with '.git'. Normalize it out.

        // procces.cwd() returns '/'
        const workspacePath = workspace.workspaceFolders?.[0]?.uri?.fsPath; // TODO: Multiple workspaces.
        if (!workspacePath) return console.warn('No workspace');
        const gitHeadPath = `${workspacePath}/.git/HEAD`;
        if (!existsSync(gitHeadPath)) return console.warn('No .git/HEAD');

        await onGitChanged(repo, gitHeadPath, store);
        const watcher = watch([
            `${workspacePath}/.git/refs/heads`, // TODO: Only watch specific branch.
        ], { ignoreInitial: true });
        watcher.on('all', (/* examples: eventName = change, path = .git/refs/heads/demo */) => {
            onGitChanged(repo, gitHeadPath, store);
        });
    })();

    async function onGitChanged(repo: Repository, gitHeadPath: string, store: Store) {
        // Get current branch. No better way:
        // * repo.log does not show branch info
        // * repo.getBranch('') returns the alphabetical first
        // * repo.getBranches({ remote: true }) doesn't show which is the current
        // TODO: Guard against !branchRef.startsWith('ref: refs/heads/')
        const branchRef = readFileSync(gitHeadPath, 'utf8').replace('ref: ', '').trim(); // example: refs/heads/demo
        const branchName = branchRef.replace('refs/heads/', '');
        const commitLocal = await repo.getCommit(branchRef);

        store.branch = branchName;
        store.commitHash = commitLocal.hash;
        await updateAnalysisInfo();
    }

    async function updateAnalysisInfo(): Promise<void> {
        const session = await authentication.getSession('github', ['security_events'], { createIfNone: true });
        const { accessToken } = session;
        if (!accessToken) {
            store.banner = 'Unable to authenticate.';
            store.analysisInfo = undefined;
        }

        const branchName = store.branch;
        const analysesResponse = await fetch(`https://api.github.com/repos/${config.user}/${config.repoName}/code-scanning/analyses?ref=refs/heads/${branchName}`, {
            headers: {
                authorization: `Bearer ${accessToken}`,
            },
        });
        if (analysesResponse.status === 403) {
            store.banner = 'GitHub Advanced Security is not enabled for this repository.';
            store.analysisInfo = undefined;
        }
        const analyses = await analysesResponse.json() as AnalysisInfo[];

        // Possibilities:
        // a) analysis is not enabled for repo or branch.
        // b) analysis is enabled, but pending.
        if (!analyses.length) {
            store.analysisInfo = undefined;
        }

        // Find the intersection.
        const git = await getInitializedGitApi();
        if (!git) return undefined; // No GitExtension or GitExtension API.

        const repo = git.repositories[0];
        const commits = await repo.log({});
        const analysisInfo = analyses.find(analysis => {
            return commits.some(commit => analysis.commit_sha === commit.hash);
        });

        // If `analysisInfo` is undefined at this point, then...
        // a) the intersection is outside of the page size
        // b) other?
        if (analysisInfo) {
            const commitsAgo = commits.findIndex(commit => commit.hash === analysisInfo.commit_sha);
            const messageWarnStale = analysisInfo.commit_sha !== store.commitHash
                ? ` The most recent scan was ${commitsAgo} commit(s) ago` +
                  ` on ${new Date(analysisInfo.created_at).toLocaleString()}.` +
                  ` Refresh to check for more current results.`
                : '';

            store.banner = `Results updated for current commit ${store.commitHash.slice(0, 7)}.` + messageWarnStale;
        } else {
            store.banner = '';
        }

        if (store.analysisInfo?.id !== analysisInfo?.id) {
            store.analysisInfo = analysisInfo;
        }
    }

    async function fetchAnalysis(analysisInfo: AnalysisInfo | undefined): Promise<void> {
        isSpinning.set(true);

        const session = await authentication.getSession('github', ['security_events'], { createIfNone: true });
        const { accessToken } = session; // Assume non-null as we already called it recently.

        const log = !analysisInfo?.id
            ? undefined
            : await (async () => {
                const uri = `https://api.github.com/repos/${config.user}/${config.repoName}/code-scanning/analyses/${analysisInfo.id}`;
                const analysisResponse = await fetch(uri, {
                    headers: {
                        accept: 'application/sarif+json',
                        authorization: `Bearer ${accessToken}`,
                    },
                });
                const logText = await analysisResponse.text();
                const log = JSON.parse(logText) as Log;
                log._text = logText;
                log._uri = uri;
                augmentLog(log, driverlessRules);
                return log;
            })();

        if (currentLogUri) {
            store.logs.removeFirst(log => log._uri === currentLogUri);
            currentLogUri = undefined;
        }

        if (log) {
            store.logs.push(log);
            currentLogUri = log._uri;
        }

        panel.show();
        isSpinning.set(false);
    }

    observe(store, 'analysisInfo', () => fetchAnalysis(store.analysisInfo));
}