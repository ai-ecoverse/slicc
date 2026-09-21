import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyReleaseExit,
  isMissingGithubIssueSuccess,
  isStaleReleasePush,
  main,
  publishRelease,
  writeDeferredOutput,
} from './release-publish.mjs';

const STALE_PUSH = `
[semantic-release] › ✘  Failed step "prepare" of plugin "@semantic-release/git"
An error occurred while running semantic-release: ExecaError: Command failed with exit code 1: git push --tags 'git@github.com:ai-ecoverse/slicc.git' 'HEAD:main'
 ! [rejected]            HEAD -> main (fetch first)
error: failed to push some refs to 'github.com:ai-ecoverse/slicc.git'
`;

describe('isStaleReleasePush', () => {
  it('matches the git plugin fetch-first rejection from a raced release', () => {
    expect(isStaleReleasePush(STALE_PUSH)).toBe(true);
  });

  it('matches the older non-fast-forward rejection wording', () => {
    expect(
      isStaleReleasePush(
        'Command failed with exit code 1: git push --tags origin HEAD:main\n ! [rejected] HEAD -> main (non-fast-forward)'
      )
    ).toBe(true);
  });

  it('does not defer a protected-branch rejection', () => {
    expect(
      isStaleReleasePush(
        'Failed step "prepare" of plugin "@semantic-release/git"\n ! [remote rejected] HEAD -> main (protected branch hook declined)'
      )
    ).toBe(false);
  });

  it('does not defer when fetch-first appears outside the git plugin failure', () => {
    expect(isStaleReleasePush('hint: fetch first, then retry the unrelated command')).toBe(false);
  });
});

const MISSING_ISSUE_SUCCESS = `
[semantic-release] › ✘  Failed step "success" of plugin "@semantic-release/github"
An error occurred while running semantic-release: Error: Could not resolve to an issue or pull request with the number of 141414.
type: 'NOT_FOUND', path: [ 'repository', 'issue141414' ]
pluginName: '@semantic-release/github'
`;

describe('isMissingGithubIssueSuccess', () => {
  it('matches the github success GraphQL lookup of a missing issue', () => {
    expect(isMissingGithubIssueSuccess(MISSING_ISSUE_SUCCESS)).toBe(true);
  });

  it('does not swallow a github publish-step failure', () => {
    expect(
      isMissingGithubIssueSuccess(
        'Failed step "publish" of plugin "@semantic-release/github"\n' +
          'Could not resolve to an issue or pull request with the number of 141414.'
      )
    ).toBe(false);
  });

  it('does not swallow an npm publish failure that mentions NOT_FOUND', () => {
    expect(isMissingGithubIssueSuccess('npm publish failed: NOT_FOUND issue141414')).toBe(false);
  });
});

describe('classifyReleaseExit', () => {
  it('keeps a successful publish', () => {
    expect(classifyReleaseExit(0, STALE_PUSH)).toEqual({ code: 0, deferred: false });
  });

  it('defers a stale-base push rejection', () => {
    expect(classifyReleaseExit(1, STALE_PUSH)).toEqual({ code: 0, deferred: true });
  });

  it('treats a missing github issue on success as a completed publish', () => {
    expect(classifyReleaseExit(1, MISSING_ISSUE_SUCCESS)).toEqual({
      code: 0,
      deferred: false,
      missingIssue: true,
    });
  });

  it('preserves any other semantic-release failure', () => {
    expect(classifyReleaseExit(1, 'npm publish failed')).toEqual({ code: 1, deferred: false });
    expect(classifyReleaseExit(null, STALE_PUSH)).toEqual({ code: 1, deferred: false });
    expect(
      classifyReleaseExit(
        1,
        'Failed step "publish" of plugin "@semantic-release/github"\n' +
          'Could not resolve to an issue or pull request with the number of 141414.'
      )
    ).toEqual({ code: 1, deferred: false });
  });
});

function fakeSpawn(closeArgs, output = '') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (output) child.stderr.emit('data', Buffer.from(output));
    child.emit('close', ...closeArgs);
  });
  return child;
}

describe('publishRelease', () => {
  it('streams output and defers the raced push', async () => {
    const stderr = { write: vi.fn() };
    const result = await publishRelease({
      spawn: () => fakeSpawn([1, null], STALE_PUSH),
      command: 'npx',
      args: ['--no-install', 'semantic-release'],
      stderr,
      stdout: { write: vi.fn() },
    });
    expect(result).toMatchObject({ code: 0, deferred: true, signal: null });
    expect(stderr.write).toHaveBeenCalled();
  });

  it('reports a signal kill without treating it as a deferral', async () => {
    const result = await publishRelease({
      spawn: () => fakeSpawn([null, 'SIGTERM'], STALE_PUSH),
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    });
    expect(result).toMatchObject({ code: null, signal: 'SIGTERM', deferred: false });
  });
});

describe('writeDeferredOutput', () => {
  it('appends deferred=true|false to GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-publish-'));
    const file = join(dir, 'out');
    try {
      expect(writeDeferredOutput(true, { GITHUB_OUTPUT: file })).toBe('deferred=true\n');
      expect(writeDeferredOutput(false, { GITHUB_OUTPUT: file })).toBe('deferred=false\n');
      expect(readFileSync(file, 'utf8')).toBe('deferred=true\ndeferred=false\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('main', () => {
  it('sets a zero exit code and explains the deferral', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.exitCode;
    const dir = mkdtempSync(join(tmpdir(), 'release-publish-'));
    const file = join(dir, 'out');
    try {
      await main([], {
        spawn: () => fakeSpawn([1, null], STALE_PUSH),
        stderr: { write: vi.fn() },
        stdout: { write: vi.fn() },
        env: { GITHUB_OUTPUT: file },
      });
      expect(process.exitCode).toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Deferring'));
      expect(readFileSync(file, 'utf8')).toBe('deferred=true\n');
    } finally {
      process.exitCode = previous;
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes deferred=false after a completed publish', async () => {
    const previous = process.exitCode;
    const dir = mkdtempSync(join(tmpdir(), 'release-publish-'));
    const file = join(dir, 'out');
    try {
      await main([], {
        spawn: () => fakeSpawn([0, null], 'Published release 6.173.4'),
        stderr: { write: vi.fn() },
        stdout: { write: vi.fn() },
        env: { GITHUB_OUTPUT: file },
      });
      expect(process.exitCode).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('deferred=false\n');
    } finally {
      process.exitCode = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets a zero exit code when github success misses a phantom issue', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.exitCode;
    const dir = mkdtempSync(join(tmpdir(), 'release-publish-'));
    const file = join(dir, 'out');
    try {
      await main([], {
        spawn: () => fakeSpawn([1, null], MISSING_ISSUE_SUCCESS),
        stderr: { write: vi.fn() },
        stdout: { write: vi.fn() },
        env: { GITHUB_OUTPUT: file },
      });
      expect(process.exitCode).toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('phantom #NNNN'));
      expect(readFileSync(file, 'utf8')).toBe('deferred=false\n');
    } finally {
      process.exitCode = previous;
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release workflow', () => {
  it('publishes through the deferral wrapper', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/release.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('node packages/dev-tools/tools/release-publish.mjs');
    expect(workflow).not.toMatch(/^\s*run: npx semantic-release\s*$/m);
    expect(workflow).toContain('id: publish');
    expect(workflow).toContain('node packages/dev-tools/tools/release-alert.mjs recover');
  });

  it('skips github success comments so a phantom issue cannot fail after publish', () => {
    const releaserc = JSON.parse(
      readFileSync(new URL('../../../.releaserc.json', import.meta.url), 'utf8')
    );
    const github = releaserc.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/github'
    );
    expect(github?.[1]).toMatchObject({
      successCommentCondition: false,
      releasedLabels: false,
      failComment: false,
      failTitle: false,
      labels: false,
    });
  });
});
