import { describe, expect, it, vi } from 'vitest';
import {
  candidateGitDirs,
  GitRemoteRepoResolver,
  repoFromGitConfig,
} from '../../src/core/git-remote-repo.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/up/stream.git
[remote "origin"]
\turl = git@github.com:me/fork.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;

describe('repoFromGitConfig', () => {
  it('prefers origin', () => {
    expect(repoFromGitConfig(CONFIG)).toBe('me/fork');
  });

  it('falls back to upstream, then to any GitHub remote', () => {
    expect(repoFromGitConfig('[remote "upstream"]\nurl = https://github.com/u/p\n')).toBe('u/p');
    expect(repoFromGitConfig('[remote "mirror"]\nurl = https://github.com/m/r\n')).toBe('m/r');
  });

  it('ignores non-GitHub remotes and configs without remotes', () => {
    expect(repoFromGitConfig('[remote "origin"]\nurl = https://gitlab.com/a/b\n')).toBeNull();
    expect(repoFromGitConfig('[core]\nbare = false\n')).toBeNull();
  });
});

describe('candidateGitDirs', () => {
  it('lists parent directories nearest first', () => {
    expect(candidateGitDirs('/workspace/slicc/src/a.ts')).toEqual([
      '/workspace/slicc/src',
      '/workspace/slicc',
      '/workspace',
    ]);
  });

  it('ignores relative paths', () => {
    expect(candidateGitDirs('src/a.ts')).toEqual([]);
  });
});

function fsWithConfigs(configs: Record<string, string>): LocalVfsClient & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readDir: () => Promise.resolve([]),
    stat: () => Promise.reject(new Error('ENOENT')),
    readFile: vi.fn((path: string) => {
      reads.push(path);
      const hit = configs[path];
      return hit === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(hit);
    }),
  } as unknown as LocalVfsClient & { reads: string[] };
}

describe('GitRemoteRepoResolver', () => {
  it('finds the checkout of the most recent path', async () => {
    const fs = fsWithConfigs({
      '/workspace/a/.git/config': '[remote "origin"]\nurl = https://github.com/o/a\n',
      '/workspace/b/.git/config': '[remote "origin"]\nurl = https://github.com/o/b\n',
    });
    const resolver = new GitRemoteRepoResolver(fs);
    expect(await resolver.repoFor(['/workspace/a/x.ts', '/workspace/b/src/y.ts'])).toBe('o/b');
  });

  it('memoizes directories it has read', async () => {
    const fs = fsWithConfigs({
      '/w/r/.git/config': '[remote "origin"]\nurl = https://github.com/o/r\n',
    });
    const resolver = new GitRemoteRepoResolver(fs);
    await resolver.repoFor(['/w/r/a.ts']);
    const before = fs.reads.length;
    expect(await resolver.repoFor(['/w/r/b.ts'])).toBe('o/r');
    expect(fs.reads.length).toBe(before);
  });

  it('decodes binary reads and returns null when nothing matches', async () => {
    const bytes = new TextEncoder().encode('[remote "origin"]\nurl = https://github.com/o/bin\n');
    const fs = {
      readDir: () => Promise.resolve([]),
      stat: () => Promise.reject(new Error('ENOENT')),
      readFile: (path: string) =>
        path === '/r/.git/config' ? Promise.resolve(bytes) : Promise.reject(new Error('ENOENT')),
    } as unknown as LocalVfsClient;
    const resolver = new GitRemoteRepoResolver(fs);
    expect(await resolver.repoFor(['/r/file.txt'])).toBe('o/bin');
    expect(await resolver.repoFor(['/elsewhere/file.txt', 'relative.txt'])).toBeNull();
  });
});
