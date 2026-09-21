#!/usr/bin/env node
/**
 * Open or close the single "Release pipeline is red" tracking issue.
 *
 * `fail` keeps one open issue current (comment if it exists, else create).
 * `recover` closes every open issue with that exact title after a green
 * publish. A stale-push deferral must not call recover — the product has
 * not shipped from that run.
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN — required
 *   GITHUB_REPOSITORY — `owner/repo`
 *   RELEASE_RUN_URL — Actions run URL
 *   RELEASE_SHA — git SHA of the run
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RED_RELEASE_TITLE = 'Release pipeline is red';

/**
 * @param {{ runUrl: string, sha: string }} input
 */
export function failBody({ runUrl, sha }) {
  return (
    `[Release run](${runUrl}) failed on \`${sha}\`. ` +
    'Everything merged since the last green release is unshipped until this is fixed.'
  );
}

/**
 * @param {{ runUrl: string, sha: string }} input
 */
export function recoverBody({ runUrl, sha }) {
  return `[Release run](${runUrl}) succeeded on \`${sha}\`. Closing — the pipeline published again.`;
}

/**
 * @param {unknown} stdout JSON from `gh issue list --json number,title`
 * @param {string} [title]
 * @returns {number[]}
 */
export function pickTrackingIssues(stdout, title = RED_RELEASE_TITLE) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((issue) => issue && issue.title === title && typeof issue.number === 'number')
    .map((issue) => issue.number);
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
export function runGh(args, env = process.env) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `gh ${args[0] ?? ''} failed`);
  }
  return result.stdout ?? '';
}

/**
 * @param {object} options
 * @param {typeof runGh} [options.runGh]
 * @param {string} options.repo
 */
export async function listTrackingIssues({ runGh: gh = runGh, repo }) {
  const stdout = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--search',
    `in:title "${RED_RELEASE_TITLE}"`,
    '--json',
    'number,title',
  ]);
  return pickTrackingIssues(stdout);
}

/**
 * @param {object} options
 * @param {typeof runGh} [options.runGh]
 * @param {string} options.repo
 * @param {string} options.runUrl
 * @param {string} options.sha
 */
export async function alertOnRedRelease({ runGh: gh = runGh, repo, runUrl, sha }) {
  const body = failBody({ runUrl, sha });
  const existing = await listTrackingIssues({ runGh: gh, repo });
  if (existing.length > 0) {
    const number = existing[0];
    gh(['issue', 'comment', String(number), '--repo', repo, '--body', body]);
    return { action: 'comment', number };
  }
  gh([
    'issue',
    'create',
    '--repo',
    repo,
    '--title',
    RED_RELEASE_TITLE,
    '--body',
    body,
    '--label',
    'bug',
  ]);
  return { action: 'create' };
}

/**
 * @param {object} options
 * @param {typeof runGh} [options.runGh]
 * @param {string} options.repo
 * @param {string} options.runUrl
 * @param {string} options.sha
 */
export async function closeOnGreenRelease({ runGh: gh = runGh, repo, runUrl, sha }) {
  const existing = await listTrackingIssues({ runGh: gh, repo });
  if (existing.length === 0) {
    console.log('No open red-release tracking issue.');
    return { action: 'none', numbers: [] };
  }
  const body = recoverBody({ runUrl, sha });
  for (const number of existing) {
    gh([
      'issue',
      'close',
      String(number),
      '--repo',
      repo,
      '--reason',
      'completed',
      '--comment',
      body,
    ]);
  }
  console.log(
    `Closed red-release tracking issue${existing.length === 1 ? '' : 's'} ${existing.join(', ')}`
  );
  return { action: 'close', numbers: existing };
}

/**
 * @param {string[]} argv
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof runGh} [options.runGh]
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  const gh = options.runGh ?? runGh;
  const action = argv[0];
  if (action !== 'fail' && action !== 'recover') {
    throw new Error('usage: release-alert.mjs fail|recover');
  }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required');
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const runUrl = env.RELEASE_RUN_URL;
  const sha = env.RELEASE_SHA;
  if (!runUrl) throw new Error('RELEASE_RUN_URL is required');
  if (!sha) throw new Error('RELEASE_SHA is required');

  if (action === 'fail') {
    return alertOnRedRelease({ runGh: gh, repo, runUrl, sha });
  }
  return closeOnGreenRelease({ runGh: gh, repo, runUrl, sha });
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();
