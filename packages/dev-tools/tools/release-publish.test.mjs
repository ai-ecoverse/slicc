import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyReleaseExit,
  isStaleReleasePush,
  main,
  publishRelease,
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

describe('classifyReleaseExit', () => {
  it('keeps a successful publish', () => {
    expect(classifyReleaseExit(0, STALE_PUSH)).toEqual({ code: 0, deferred: false });
  });

  it('defers a stale-base push rejection', () => {
    expect(classifyReleaseExit(1, STALE_PUSH)).toEqual({ code: 0, deferred: true });
  });

  it('preserves any other semantic-release failure', () => {
    expect(classifyReleaseExit(1, 'npm publish failed')).toEqual({ code: 1, deferred: false });
    expect(classifyReleaseExit(null, STALE_PUSH)).toEqual({ code: 1, deferred: false });
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

describe('main', () => {
  it('sets a zero exit code and explains the deferral', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      await main([], {
        spawn: () => fakeSpawn([1, null], STALE_PUSH),
        stderr: { write: vi.fn() },
        stdout: { write: vi.fn() },
      });
      expect(process.exitCode).toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Deferring'));
    } finally {
      process.exitCode = previous;
      error.mockRestore();
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
  });
});
