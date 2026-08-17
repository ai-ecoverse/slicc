/**
 * Tests for the canonical HOME resolver (#2085).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_DIR, resolveHomeDir, userFromHome } from '../../src/shell/home-dir.js';

type Entry = { name: string; type: string };

function fakeFs(dirs: Record<string, Entry[]>, mtimes: Record<string, number>) {
  return {
    async readDir(path: string): Promise<Entry[]> {
      const entries = dirs[path];
      if (!entries) throw new Error(`ENOENT: ${path}`);
      return entries;
    },
    async stat(path: string): Promise<{ mtime?: number }> {
      if (!(path in mtimes)) throw new Error(`ENOENT: ${path}`);
      return { mtime: mtimes[path] };
    },
  };
}

describe('resolveHomeDir', () => {
  it('falls back to the default when /home does not exist', async () => {
    expect(await resolveHomeDir(fakeFs({}, {}))).toBe(DEFAULT_HOME_DIR);
  });

  it('falls back to the default when /home is empty', async () => {
    expect(await resolveHomeDir(fakeFs({ '/home': [] }, {}))).toBe(DEFAULT_HOME_DIR);
  });

  it('resolves the single onboarded home', async () => {
    const fs = fakeFs(
      { '/home': [{ name: 'lars', type: 'directory' }] },
      { '/home/lars/.welcome.json': 100 }
    );
    expect(await resolveHomeDir(fs)).toBe('/home/lars');
  });

  it('prefers the most recently onboarded slug when several exist', async () => {
    // Repeated onboardings leave older slugs behind; mirror
    // setup-welcome-flow's mtime-newest rule so HOME and the welcome
    // fast-forward agree on the same identity.
    const fs = fakeFs(
      {
        '/home': [
          { name: 'old-name', type: 'directory' },
          { name: 'new-name', type: 'directory' },
        ],
      },
      { '/home/old-name/.welcome.json': 100, '/home/new-name/.welcome.json': 200 }
    );
    expect(await resolveHomeDir(fs)).toBe('/home/new-name');
  });

  it('a profile-bearing home outranks a profile-less one regardless of order', async () => {
    const fs = fakeFs(
      {
        '/home': [
          { name: 'stray', type: 'directory' },
          { name: 'lars', type: 'directory' },
        ],
      },
      { '/home/lars/.welcome.json': 50 }
    );
    expect(await resolveHomeDir(fs)).toBe('/home/lars');
  });

  it('uses the first profile-less directory when no profiles exist', async () => {
    const fs = fakeFs({ '/home': [{ name: 'manual', type: 'directory' }] }, {});
    expect(await resolveHomeDir(fs)).toBe('/home/manual');
  });

  it('ignores plain files inside /home', async () => {
    const fs = fakeFs({ '/home': [{ name: 'README.md', type: 'file' }] }, {});
    expect(await resolveHomeDir(fs)).toBe(DEFAULT_HOME_DIR);
  });
});

describe('userFromHome', () => {
  it('derives the user from the home basename', () => {
    expect(userFromHome('/home/lars')).toBe('lars');
    expect(userFromHome('/scoops/research/home')).toBe('home');
    expect(userFromHome('/home/user/')).toBe('user');
  });

  it('falls back to "user" for degenerate paths', () => {
    expect(userFromHome('/')).toBe('user');
    expect(userFromHome('')).toBe('user');
  });
});
