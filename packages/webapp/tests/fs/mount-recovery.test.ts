import { describe, it, expect, vi } from 'vitest';
import {
  recoverMounts,
  formatMountRecoveryPrompt,
  mdInlineCode,
  shellQuote,
  type MountRecoveryFS,
} from '../../src/fs/mount-recovery.js';
import type { MountEntry } from '../../src/fs/mount-table-store.js';

type PermissionState = 'granted' | 'prompt' | 'denied';

interface MockHandleOptions {
  name: string;
  permission?: PermissionState;
  /** Omit `queryPermission` from the handle object (simulates stale/old record). */
  withoutQueryPermission?: boolean;
  /** Force `queryPermission` to throw. */
  throwOnQuery?: boolean;
}

function mockHandle(opts: MockHandleOptions): FileSystemDirectoryHandle {
  const { name, permission = 'granted', withoutQueryPermission, throwOnQuery } = opts;
  const handle: Record<string, unknown> = { kind: 'directory', name };
  if (!withoutQueryPermission) {
    handle.queryPermission = async (_desc: { mode: string }) => {
      if (throwOnQuery) throw new Error('boom');
      return permission;
    };
  }
  return handle as unknown as FileSystemDirectoryHandle;
}

function mockFs(mountImpl?: (path: string, handle: FileSystemDirectoryHandle) => Promise<void>): {
  fs: MountRecoveryFS;
  mounts: Array<{ path: string; name: string }>;
} {
  const mounts: Array<{ path: string; name: string }> = [];
  const fs: MountRecoveryFS = {
    mount: async (path: string, handle: FileSystemDirectoryHandle) => {
      if (mountImpl) await mountImpl(path, handle);
      mounts.push({ path, name: handle.name });
    },
  };
  return { fs, mounts };
}

describe('recoverMounts', () => {
  it('silently remounts handles whose permission is still granted', async () => {
    const entries: MountEntry[] = [
      { path: '/workspace/a', handle: mockHandle({ name: 'a', permission: 'granted' }) },
      { path: '/workspace/b', handle: mockHandle({ name: 'b', permission: 'granted' }) },
    ];
    const { fs, mounts } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([
      { path: '/workspace/a', dirName: 'a' },
      { path: '/workspace/b', dirName: 'b' },
    ]);
    expect(result.needsRecovery).toEqual([]);
    expect(mounts).toEqual([
      { path: '/workspace/a', name: 'a' },
      { path: '/workspace/b', name: 'b' },
    ]);
  });

  it('flags handles whose permission dropped to `prompt` as needing recovery', async () => {
    const entries: MountEntry[] = [
      { path: '/workspace/a', handle: mockHandle({ name: 'a', permission: 'prompt' }) },
      { path: '/workspace/b', handle: mockHandle({ name: 'b', permission: 'denied' }) },
    ];
    const { fs, mounts } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([
      { path: '/workspace/a', dirName: 'a' },
      { path: '/workspace/b', dirName: 'b' },
    ]);
    expect(mounts).toEqual([]);
  });

  it('flags handles that lost `queryPermission` as needing recovery', async () => {
    const entries: MountEntry[] = [
      {
        path: '/workspace/legacy',
        handle: mockHandle({ name: 'legacy', withoutQueryPermission: true }),
      },
    ];
    const { fs } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/legacy', dirName: 'legacy' }]);
  });

  it('flags handles whose queryPermission throws as needing recovery', async () => {
    const warn = vi.fn();
    const entries: MountEntry[] = [
      {
        path: '/workspace/broken',
        handle: mockHandle({ name: 'broken', throwOnQuery: true }),
      },
    ];
    const { fs } = mockFs();
    const result = await recoverMounts(entries, fs, { warn });
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/broken', dirName: 'broken' }]);
    expect(warn).toHaveBeenCalledWith(
      'queryPermission threw on persisted handle',
      expect.objectContaining({ path: '/workspace/broken' })
    );
  });

  it('falls back to needsRecovery when the fs mount call itself throws', async () => {
    const warn = vi.fn();
    const entries: MountEntry[] = [
      { path: '/workspace/x', handle: mockHandle({ name: 'x', permission: 'granted' }) },
    ];
    const fs: MountRecoveryFS = {
      mount: async () => {
        throw new Error('mount failed');
      },
    };
    const result = await recoverMounts(entries, fs, { warn });
    expect(result.restored).toEqual([]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/x', dirName: 'x' }]);
    expect(warn).toHaveBeenCalledWith(
      'Failed to re-mount persisted handle',
      expect.objectContaining({ path: '/workspace/x' })
    );
  });

  it('returns empty arrays when there are no entries', async () => {
    const { fs } = mockFs();
    const result = await recoverMounts([], fs);
    expect(result).toEqual({ restored: [], needsRecovery: [] });
  });

  it('mixes restored and needs-recovery correctly in a single pass', async () => {
    const entries: MountEntry[] = [
      { path: '/workspace/ok', handle: mockHandle({ name: 'ok', permission: 'granted' }) },
      { path: '/workspace/stale', handle: mockHandle({ name: 'stale', permission: 'prompt' }) },
    ];
    const { fs } = mockFs();
    const result = await recoverMounts(entries, fs);
    expect(result.restored).toEqual([{ path: '/workspace/ok', dirName: 'ok' }]);
    expect(result.needsRecovery).toEqual([{ path: '/workspace/stale', dirName: 'stale' }]);
  });
});

describe('formatMountRecoveryPrompt', () => {
  it('returns null when there are no mounts to recover', () => {
    expect(formatMountRecoveryPrompt([])).toBeNull();
  });

  it('returns null for non-array input (defensive)', () => {
    expect(formatMountRecoveryPrompt(undefined as unknown as [])).toBeNull();
  });

  it('produces a single-mount prompt that includes the mount command', () => {
    const prompt = formatMountRecoveryPrompt([
      { path: '/workspace/my-project', dirName: 'my-project' },
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('Mount recovery required');
    expect(prompt).toContain('1 mount point');
    expect(prompt).toContain('`/workspace/my-project`');
    expect(prompt).toContain('previously mounted from `my-project`');
    expect(prompt).toContain("mount '/workspace/my-project'");
    expect(prompt).toContain('mount unmount');
  });

  it('pluralizes when multiple mounts need recovery', () => {
    const prompt = formatMountRecoveryPrompt([
      { path: '/workspace/a', dirName: 'a' },
      { path: '/workspace/b', dirName: 'b' },
    ]);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('2 mount points');
    expect(prompt).toContain("mount '/workspace/a'");
    expect(prompt).toContain("mount '/workspace/b'");
  });

  it('omits the original directory name when it is unknown', () => {
    const prompt = formatMountRecoveryPrompt([{ path: '/mnt/data', dirName: '' }]);
    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain('previously mounted');
    expect(prompt).toContain('/mnt/data');
  });

  it('shell-quotes mount paths containing spaces so they parse as one argv token', () => {
    const prompt = formatMountRecoveryPrompt([{ path: '/mnt/My Project', dirName: 'My Project' }]);
    expect(prompt).not.toBeNull();
    // The command must keep the path as a single argv token.
    expect(prompt).toContain("mount '/mnt/My Project'");
    // And must NOT emit the unsafe, whitespace-splitting form.
    expect(prompt).not.toMatch(/^ {4}mount \/mnt\/My Project$/m);
  });

  it('escapes single quotes inside shell-quoted mount paths', () => {
    const prompt = formatMountRecoveryPrompt([{ path: "/mnt/It's Work", dirName: "It's Work" }]);
    expect(prompt).not.toBeNull();
    // POSIX single-quote escape: close, escape, reopen.
    expect(prompt).toContain("mount '/mnt/It'\\''s Work'");
  });

  it('uses a wider backtick delimiter when a value contains backticks', () => {
    const prompt = formatMountRecoveryPrompt([{ path: '/mnt/weird`path', dirName: 'weird`dir' }]);
    expect(prompt).not.toBeNull();
    // Embedded `s force a `` … `` inline code fence so markdown stays valid.
    expect(prompt).toContain('``/mnt/weird`path``');
    expect(prompt).toContain('``weird`dir``');
  });

  it('collapses newlines inside Markdown inline code so the bullet renders on one line', () => {
    const prompt = formatMountRecoveryPrompt([
      { path: '/mnt/line1\nline2', dirName: 'weird\r\nname' },
    ]);
    expect(prompt).not.toBeNull();
    // Inline code must not straddle a newline (CommonMark forbids it).
    expect(prompt).toContain('`/mnt/line1 line2`');
    expect(prompt).toContain('`weird name`');
    // The indented shell command is a code block, not inline code, so the
    // POSIX-correct single-quote form still preserves the real newline
    // there — callers treat the path as opaque, we don't rewrite it.
  });
});

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellQuote('/workspace/app')).toBe("'/workspace/app'");
  });

  it('preserves spaces inside the quoted form', () => {
    expect(shellQuote('/mnt/My Project')).toBe("'/mnt/My Project'");
  });

  it('escapes embedded single quotes using the POSIX close-reopen trick', () => {
    expect(shellQuote("It's")).toBe("'It'\\''s'");
  });

  it('handles strings with only single quotes', () => {
    expect(shellQuote("'")).toBe("''\\'''");
  });

  it('handles empty strings', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('mdInlineCode', () => {
  it('wraps plain values in single backticks', () => {
    expect(mdInlineCode('/workspace/app')).toBe('`/workspace/app`');
  });

  it('uses a longer delimiter when the value contains a backtick', () => {
    expect(mdInlineCode('a`b')).toBe('``a`b``');
  });

  it('uses a still-longer delimiter when the value contains a run of backticks', () => {
    expect(mdInlineCode('a``b')).toBe('```a``b```');
  });

  it('pads leading/trailing backticks with a space so CommonMark parses cleanly', () => {
    expect(mdInlineCode('`leading')).toBe('`` `leading ``');
    expect(mdInlineCode('trailing`')).toBe('`` trailing` ``');
  });

  it('collapses CR/LF to a single space', () => {
    expect(mdInlineCode('line1\nline2')).toBe('`line1 line2`');
    expect(mdInlineCode('a\r\nb')).toBe('`a b`');
  });
});
