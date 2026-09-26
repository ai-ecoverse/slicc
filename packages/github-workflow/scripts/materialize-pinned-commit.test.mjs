import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, materializePinnedCommit } from './materialize-pinned-commit.mjs';

describe('materialize-pinned-commit', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fetches the ref, builds in a worktree, and records the node-server entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'pin-commit-'));
    dirs.push(root);
    const dest = join(root, 'tree');
    const repo = join(root, 'repo');
    const calls = [];
    const exec = (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd, husky: opts.env.HUSKY });
      if (args[0] === 'run' && args.at(-1) === '@slicc/node-server') {
        mkdirSync(join(dest, 'dist', 'node-server'), { recursive: true });
        mkdirSync(join(dest, 'dist', 'ui'), { recursive: true });
        writeFileSync(join(dest, 'dist', 'node-server', 'index.js'), '');
        writeFileSync(join(dest, 'dist', 'ui', 'index.html'), '<title>ui</title>');
      }
    };
    const output = join(root, 'out');
    writeFileSync(output, '');
    const previous = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = output;
    const built = main({
      ref: 'abc1234',
      dest,
      repo,
      exec,
      env: { PATH: '/usr/bin' },
    });
    process.env.GITHUB_OUTPUT = previous;
    expect(built.nodeServer).toBe(join(dest, 'dist', 'node-server', 'index.js'));
    expect(calls.map((call) => [call.cmd, ...call.args])).toEqual([
      ['git', 'fetch', '--depth', '1', 'origin', 'abc1234'],
      ['git', 'worktree', 'add', '--detach', dest, 'FETCH_HEAD'],
      ['npm', 'ci'],
      ['npm', 'run', 'build', '-w', '@slicc/webapp'],
      ['npm', 'run', 'build', '-w', '@slicc/node-server'],
    ]);
    expect(calls[0].cwd).toBe(repo);
    expect(calls[2].cwd).toBe(dest);
    expect(calls[2].husky).toBe('0');
    expect(readFileSync(output, 'utf8')).toContain(`node-server=${built.nodeServer}`);
  });

  it('does nothing for the npm-package pin and fails a build that produced no UI', () => {
    expect(materializePinnedCommit({ ref: 'true', dest: '/unused', exec: () => {} })).toBeNull();
    expect(main({ ref: 'true', dest: '/unused', exec: () => {} })).toBeNull();
    expect(() => main({ ref: 'abc1234' })).toThrow(/PIN_DEST/);
    expect(() =>
      materializePinnedCommit({
        ref: 'abc1234',
        dest: '/missing',
        repo: '/repo',
        exec: () => {},
      })
    ).toThrow(/did not produce/);
  });
});
