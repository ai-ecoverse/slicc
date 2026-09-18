#!/usr/bin/env node

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
