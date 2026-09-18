import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildComputerAddScreenResolvedCommand,
  finishAdoptedScreenRegistration,
  localMountIdbKey,
  parseComputerAddScreenCommand,
  parseLocalMountTarget,
} from '../../src/kernel/remote-terminal-view.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('localMountIdbKey', () => {
  it('returns `pendingMount:term:<target>` verbatim', () => {
    expect(localMountIdbKey('/mnt/foo')).toBe('pendingMount:term:/mnt/foo');
    expect(localMountIdbKey('/mnt/with space')).toBe('pendingMount:term:/mnt/with space');
  });

  it('matches the format the worker-side mountLocal expects', () => {
    const target = '/mnt/kb';
    expect(localMountIdbKey(target)).toBe(`pendingMount:term:${target}`);
  });
});

describe('parseLocalMountTarget', () => {
  it('matches `mount /mnt/foo`', () => {
    expect(parseLocalMountTarget('mount /mnt/foo')).toBe('/mnt/foo');
  });

  it('matches with leading / trailing whitespace', () => {
    expect(parseLocalMountTarget('   mount /mnt/foo   ')).toBe('/mnt/foo');
  });

  it('returns null for `mount` alone', () => {
    expect(parseLocalMountTarget('mount')).toBeNull();
    expect(parseLocalMountTarget('mount ')).toBeNull();
  });

  it('returns null for `mount list` / `mount unmount` / `mount refresh` / `mount info`', () => {
    expect(parseLocalMountTarget('mount list')).toBeNull();
    expect(parseLocalMountTarget('mount unmount /mnt/x')).toBeNull();
    expect(parseLocalMountTarget('mount refresh /mnt/x')).toBeNull();
    expect(parseLocalMountTarget('mount info /tmp')).toBeNull();
    expect(parseLocalMountTarget('mount info --json /mnt/kb')).toBeNull();
  });

  it('returns null for `mount --list` / `mount -l` even with a trailing path', () => {
    expect(parseLocalMountTarget('mount --list')).toBeNull();
    expect(parseLocalMountTarget('mount -l')).toBeNull();
    expect(parseLocalMountTarget('mount --list /mnt/x')).toBeNull();
    expect(parseLocalMountTarget('mount -l /mnt/x')).toBeNull();
  });

  it('returns null when --source is present (S3 / DA mounts)', () => {
    expect(parseLocalMountTarget('mount /mnt/x --source s3://bucket')).toBeNull();
    expect(parseLocalMountTarget('mount --source da://repo /mnt/x')).toBeNull();
  });

  it('returns null when --help / -h is present', () => {
    expect(parseLocalMountTarget('mount --help')).toBeNull();
    expect(parseLocalMountTarget('mount -h')).toBeNull();
  });

  it('returns null when target is not absolute', () => {
    expect(parseLocalMountTarget('mount foo')).toBeNull();
    expect(parseLocalMountTarget('mount ./foo')).toBeNull();
  });

  it('returns null for unrelated commands that start with "mount"', () => {
    expect(parseLocalMountTarget('mountain /mnt/x')).toBeNull();
    expect(parseLocalMountTarget('mountpoint /mnt/x')).toBeNull();
  });

  it('handles --no-probe and other flags between mount and target', () => {
    expect(parseLocalMountTarget('mount --no-probe /mnt/x')).toBe('/mnt/x');
  });
});

describe('parseComputerAddScreenCommand', () => {
  it('matches computer add screen and optional -n', () => {
    expect(parseComputerAddScreenCommand('computer add screen')).toEqual({});
    expect(parseComputerAddScreenCommand('computer add screen -n Desk')).toEqual({ name: 'Desk' });
    expect(parseComputerAddScreenCommand('computer add screen --name Desk')).toEqual({
      name: 'Desk',
    });
  });

  it('returns null once the picker already resolved or for help', () => {
    expect(parseComputerAddScreenCommand('computer add screen --__resolved screen1')).toBeNull();
    expect(parseComputerAddScreenCommand('computer add screen --help')).toBeNull();
    expect(parseComputerAddScreenCommand('computer add tab T1')).toBeNull();
  });

  it('keeps quoted -n names as a single token', () => {
    expect(parseComputerAddScreenCommand('computer add screen -n "My Desk"')).toEqual({
      name: 'My Desk',
    });
    expect(parseComputerAddScreenCommand("computer add screen --name 'Conference Room'")).toEqual({
      name: 'Conference Room',
    });
  });
});

describe('buildComputerAddScreenResolvedCommand', () => {
  it('quotes names that contain whitespace instead of re-splitting', () => {
    expect(buildComputerAddScreenResolvedCommand('screen1', 'My Desk')).toBe(
      'computer add screen --__resolved screen1 -n "My Desk"'
    );
    expect(parseComputerAddScreenCommand('computer add screen -n "My Desk"')).toEqual({
      name: 'My Desk',
    });
  });
});

describe('finishAdoptedScreenRegistration', () => {
  it('leaves the adopted session running when registration succeeds', async () => {
    const stopped: string[] = [];
    const seen: string[] = [];
    const result = await finishAdoptedScreenRegistration(
      async (command) => {
        seen.push(command);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      (handle) => {
        stopped.push(handle);
      },
      'screen1',
      'My Desk'
    );
    expect(result.exitCode).toBe(0);
    expect(stopped).toEqual([]);
    expect(seen).toEqual(['computer add screen --__resolved screen1 -n "My Desk"']);
  });

  it('stops the adopted session on a nonzero registration result', async () => {
    const stopped: string[] = [];
    await finishAdoptedScreenRegistration(
      async () => ({ stdout: '', stderr: 'closed', exitCode: 1 }),
      (handle) => {
        stopped.push(handle);
      },
      'screen2'
    );
    expect(stopped).toEqual(['screen2']);
  });

  it('stops the adopted session when registration throws', async () => {
    const stopped: string[] = [];
    await expect(
      finishAdoptedScreenRegistration(
        async () => {
          throw new Error('exec failed');
        },
        (handle) => {
          stopped.push(handle);
        },
        'screen3'
      )
    ).rejects.toThrow('exec failed');
    expect(stopped).toEqual(['screen3']);
  });
});

describe('regression: storePendingHandle import shape', () => {
  const REMOTE_TERMINAL_VIEW = resolve(__dirname, '../../src/kernel/remote-terminal-view.ts');
  const src = readFileSync(REMOTE_TERMINAL_VIEW, 'utf8');

  it('imports storePendingHandle statically from mount-picker-popup', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bstorePendingHandle\b[^}]*\}\s*from\s*['"]\.\.\/fs\/mount-picker-popup\.js['"]/
    );
  });

  it('does not dynamically import mount-picker-popup', () => {
    expect(src).not.toMatch(/import\s*\(\s*['"][^'"]*mount-picker-popup[^'"]*['"]\s*\)/);
  });
});
