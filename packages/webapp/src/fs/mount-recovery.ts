/**
 * Mount recovery — bridge between the persisted mount table and the
 * File System Access API's permission model.
 *
 * ## Why some reloads require recovery and some don't
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable and survives an
 * IndexedDB round-trip, but its readwrite permission is *not* part of the
 * clone. Chrome's behaviour:
 *
 * - **Same tab, soft navigation / Vite HMR / SPA route change**
 *   → `queryPermission({ mode: 'readwrite' })` usually returns `granted`
 *   because the permission lives on the tab's top-level document. We can
 *   silently re-`mount()` the handle with no user interaction.
 *
 * - **Full page reload / cold tab open / browser restart**
 *   → permission drops to `prompt` (or occasionally `denied`). The only
 *   way to restore it is a user gesture that calls
 *   `handle.requestPermission({ mode: 'readwrite' })` or a fresh
 *   `showDirectoryPicker()`. We cannot prompt without a gesture, so we
 *   surface the list to the cone and ask it to walk the user through
 *   re-mounting.
 *
 * - **Very old handle, browser upgrade, or missing methods**
 *   → `queryPermission` may throw or be absent on the rehydrated object.
 *   We treat that the same as "needs recovery" — better to ask than to
 *   silently leave the path mounted-but-empty.
 *
 * The upshot for users: a full browser restart will typically need
 * re-authorization; a tab reload while the browser was running may not.
 * This is File System Access API policy, not SLICC policy — the recovery
 * helper just observes which bucket each handle is in.
 */

import type { MountEntry } from './mount-table-store.js';

export interface MountRecoveryEntry {
  /** VFS mount point (e.g. `/workspace/my-project`). */
  path: string;
  /** Original directory name captured from the handle (`handle.name`). */
  dirName: string;
}

export interface MountRecoveryResult {
  /** Entries that were silently re-mounted because permission was still granted. */
  restored: MountRecoveryEntry[];
  /** Entries that require a new user gesture to regain filesystem access. */
  needsRecovery: MountRecoveryEntry[];
}

/** Minimal FS surface needed to re-mount a handle — lets tests stub this. */
export interface MountRecoveryFS {
  mount(path: string, handle: FileSystemDirectoryHandle): Promise<void> | void;
}

/** Logger surface accepted by `recoverMounts`. Everything is optional. */
export interface MountRecoveryLogger {
  info?: (msg: string, data?: unknown) => void;
  warn?: (msg: string, data?: unknown) => void;
}

/**
 * Walk persisted mount entries and try to silently re-mount each one.
 * Returns two buckets: handles we restored, and handles that need the
 * user to re-grant permission.
 *
 * Callers should only surface `needsRecovery` to the agent — if the list
 * is empty, the reload was a silent success and no lick should fire.
 */
export async function recoverMounts(
  entries: MountEntry[],
  fs: MountRecoveryFS,
  log?: MountRecoveryLogger
): Promise<MountRecoveryResult> {
  const restored: MountRecoveryEntry[] = [];
  const needsRecovery: MountRecoveryEntry[] = [];

  for (const { path, handle } of entries) {
    const dirName = typeof handle?.name === 'string' ? handle.name : '';

    if (!handle || !('queryPermission' in handle)) {
      needsRecovery.push({ path, dirName });
      continue;
    }

    let perm: string;
    try {
      perm = await (
        handle as unknown as {
          queryPermission: (desc: { mode: string }) => Promise<string>;
        }
      ).queryPermission({ mode: 'readwrite' });
    } catch (err) {
      log?.warn?.('queryPermission threw on persisted handle', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      needsRecovery.push({ path, dirName });
      continue;
    }

    if (perm !== 'granted') {
      needsRecovery.push({ path, dirName });
      continue;
    }

    try {
      await fs.mount(path, handle);
      log?.info?.('Restored mount from previous session', { path, name: dirName });
      restored.push({ path, dirName });
    } catch (err) {
      log?.warn?.('Failed to re-mount persisted handle', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      needsRecovery.push({ path, dirName });
    }
  }

  return { restored, needsRecovery };
}

/**
 * Build a natural-language prompt for the cone describing mount points
 * that lost their permission on reload. The prompt is self-contained:
 * it tells the cone to inform the user and offer the exact `mount`
 * commands needed to re-authorize.
 *
 * Returns `null` when there is nothing to report — callers should treat
 * a `null` result as "do not emit a lick".
 */
export function formatMountRecoveryPrompt(mounts: MountRecoveryEntry[]): string | null {
  if (!Array.isArray(mounts) || mounts.length === 0) return null;

  const listLines = mounts.map(({ path, dirName }) => {
    const origin = dirName ? ` (previously mounted from \`${dirName}\`)` : '';
    return `- \`${path}\`${origin}`;
  });
  const mountCmds = mounts.map(({ path }) => `    mount ${path}`);

  const noun = mounts.length === 1 ? 'mount point' : 'mount points';
  const pronoun = mounts.length === 1 ? 'it' : 'them';

  return [
    `[Session Reload] Mount recovery required for ${mounts.length} ${noun}.`,
    '',
    `The page was reloaded and the following ${noun} lost filesystem permission. The browser cannot restore access without a fresh user gesture, so ${pronoun} cannot be used until the user re-authorizes:`,
    '',
    ...listLines,
    '',
    'Please tell the user what happened and ask whether they want to re-mount. If yes, run the corresponding command(s) so the folder picker opens and they can re-select the same directory:',
    '',
    ...mountCmds,
    '',
    'If the user no longer needs a mount, run `mount unmount <path>` instead to clear the stale entry.',
  ].join('\n');
}
