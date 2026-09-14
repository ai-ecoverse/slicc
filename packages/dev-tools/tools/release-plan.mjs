#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';

const LOG_FORMAT = '%H%x1f%B%x1e';

export function parseGitLog(output) {
  return String(output ?? '')
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\x1f');
      if (separator < 0) throw new Error('Malformed git log record');
      return {
        hash: record.slice(0, separator).trim(),
        message: record.slice(separator + 1).trim(),
      };
    });
}

export function getLastReleaseTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function getCommitsSince(lastTag) {
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  return parseGitLog(
    execFileSync('git', ['log', `--format=${LOG_FORMAT}`, range], { encoding: 'utf8' })
  );
}

export async function determineReleaseType(commits, cwd = process.cwd()) {
  return analyzeCommits(
    {},
    {
      commits,
      cwd,
      logger: { log() {} },
    }
  );
}

export async function main() {
  const lastTag = getLastReleaseTag();
  const releaseType = await determineReleaseType(getCommitsSince(lastTag));
  console.log(releaseType ?? 'none');
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();
