#!/usr/bin/env node
/**
 * Report whether the default-branch merge queue has any entries.
 *
 * Writes `busy=true|false` and `count=<n>` to `$GITHUB_OUTPUT` when set.
 * Used by Release to defer publishing while the queue is draining — the
 * merge queue must not wait on Release (the old `release-gate` poll).
 *
 * Env:
 *   GITHUB_TOKEN / GH_TOKEN — required
 *   GITHUB_REPOSITORY — `owner/repo` (Actions default)
 *   MERGE_QUEUE_BRANCH — defaults to `main`
 */

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchMergeQueueEntryCount } from './merge-queue-lib.mjs';

export function parseRepository(repository) {
  const value = String(repository ?? '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`GITHUB_REPOSITORY must be owner/repo, got ${JSON.stringify(repository)}`);
  }
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

export async function main(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required');

  const { owner, repo } = parseRepository(env.GITHUB_REPOSITORY);
  const branch = env.MERGE_QUEUE_BRANCH || 'main';
  const count = await fetchMergeQueueEntryCount({ owner, repo, branch, token });
  const busy = count > 0;

  const lines = [`busy=${busy}`, `count=${count}`];
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }

  if (busy) {
    console.log(`Merge queue busy: ${count} entr${count === 1 ? 'y' : 'ies'} on ${branch}`);
  } else {
    console.log(`Merge queue idle on ${branch}`);
  }

  return { busy, count };
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();
