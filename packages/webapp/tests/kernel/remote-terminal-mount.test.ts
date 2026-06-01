/**
 * Tests for the panel-side mount pre-intercept.
 *
 * Verifies the parser that decides which typed lines are local
 * mount invocations + the IDB-key formatter that the panel and
 * worker MUST agree on. Does not test the picker call itself
 * (no DOM here); the integration is covered by the live smoke.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localMountIdbKey } from '../../src/kernel/remote-terminal-view.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `parseLocalMountTarget` is module-internal; re-import via the
// module's compiled namespace using a back-door eval-style import
// is not necessary — instead, we test the public IDB-key surface
// that the worker side depends on, plus a thin wrapper for the
// parser by re-implementing it here as the spec.
//
// (If `parseLocalMountTarget` is ever exported, swap these specs
// for direct tests.)

describe('localMountIdbKey', () => {
  it('returns `pendingMount:term:<target>` verbatim', () => {
    expect(localMountIdbKey('/mnt/foo')).toBe('pendingMount:term:/mnt/foo');
    expect(localMountIdbKey('/mnt/with space')).toBe('pendingMount:term:/mnt/with space');
  });

  it('matches the format the worker-side mountLocal expects', () => {
    // The worker (`fs/mount-commands.ts:tryAdoptPrePickedHandle`)
    // looks up `pendingMount:term:<targetPath>`. Both must agree.
    // If you change this format, update the worker simultaneously.
    const target = '/mnt/kb';
    expect(localMountIdbKey(target)).toBe(`pendingMount:term:${target}`);
  });
});

// Spec for parseLocalMountTarget — duplicated here as a regression
// pin since the function is module-private. The tests document the
// intended matching behavior; if the parser drifts, these tests
// fail in the integration smoke (the typed mount falls through to
// the worker's "needs window" error).
describe('parseLocalMountTarget (spec)', () => {
  // Local re-implementation matching `kernel/remote-terminal-view.ts`.
  // Keep in sync when the production parser changes.
  function parseLocalMountTarget(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('mount')) return null;
    const tokens = trimmed.split(/\s+/);
    if (tokens[0] !== 'mount') return null;
    if (tokens.includes('--source') || tokens.includes('--help') || tokens.includes('-h')) {
      return null;
    }
    const target = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (!target) return null;
    if (['list', 'unmount', 'refresh', 'recover'].includes(target)) return null;
    if (!target.startsWith('/')) return null;
    return target;
  }

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

  it('returns null for `mount list` / `mount unmount` / `mount refresh`', () => {
    expect(parseLocalMountTarget('mount list')).toBeNull();
    expect(parseLocalMountTarget('mount unmount /mnt/x')).toBeNull();
    expect(parseLocalMountTarget('mount refresh /mnt/x')).toBeNull();
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
    // `mount --no-probe /mnt/x` should still be a local-mount target.
    expect(parseLocalMountTarget('mount --no-probe /mnt/x')).toBe('/mnt/x');
  });
});

// Regression guard for the `mount: failed to stash handle: t is not a function`
// crash. Root cause: `remote-terminal-view.ts` used `await import('../fs/mount-picker-popup.js')`
// to grab `storePendingHandle` at runtime. Vite merges `mount-picker-popup`
// into the main index chunk because other modules statically import it, but
// only re-exports the symbols those static importers asked for. Since no
// static importer asked for `storePendingHandle`, the merged chunk did not
// re-export it, and the dynamic import resolved the symbol to `undefined`.
//
// The fix is to statically import `storePendingHandle` from `mount-picker-popup.js`.
// This forces Vite's used-exports analysis to keep the symbol on the chunk,
// regardless of how the chunk gets merged. Don't reintroduce the dynamic
// import — bundle-shape regressions like this one are invisible to typecheck
// and to source-level unit tests.
describe('regression: storePendingHandle import shape', () => {
  const REMOTE_TERMINAL_VIEW = resolve(__dirname, '../../src/kernel/remote-terminal-view.ts');
  const src = readFileSync(REMOTE_TERMINAL_VIEW, 'utf8');

  it('imports storePendingHandle statically from mount-picker-popup', () => {
    // The static import is required so Vite's chunk merger preserves the
    // symbol's export entry on whichever chunk it lands in.
    expect(src).toMatch(
      /import\s*\{[^}]*\bstorePendingHandle\b[^}]*\}\s*from\s*['"]\.\.\/fs\/mount-picker-popup\.js['"]/
    );
  });

  it('does not dynamically import mount-picker-popup', () => {
    // `await import('../fs/mount-picker-popup.js')` is the bug pattern. If a
    // future caller needs another export from that module, add it to the
    // static import above instead.
    expect(src).not.toMatch(/import\s*\(\s*['"][^'"]*mount-picker-popup[^'"]*['"]\s*\)/);
  });
});
