/**
 * Mount recovery — bridge between the persisted mount table and the
 * runtime backends.
 *
 * ## Why some reloads require recovery and some don't
 *
 * For LOCAL backends (FS Access API):
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
 * For REMOTE backends (S3, DA):
 * Recovery is pure cred resolution + backend instantiation. If the
 * profile still resolves (S3 secrets present; IMS token still valid),
 * the mount auto-restores silently. Otherwise the entry surfaces in
 * `needsRecovery` with an actionable retry hint.
 *
 * The S3 and DA branches in `recoverMounts` below are stubbed out —
 * they fall straight into `needsRecovery` until Phase 11 (S3 backend)
 * and Phase 12 (DA backend) wire their reconstruction paths.
 */

import { LocalMountBackend } from './mount/backend-local.js';
import {
  S3MountBackend,
  RemoteMountCache,
  resolveS3Profile,
  getDefaultSecretStore,
} from './mount/index.js';
import type { MountBackend } from './mount/backend.js';
import { loadMountHandle } from './mount-table-store.js';
import type { MountTableEntry } from './mount-table-store.js';

/**
 * Discriminated `MountRecoveryEntry`. Local entries carry the captured
 * `dirName` (handle.name); remote entries carry the source URI, profile
 * name, and a `reason` string describing why recovery couldn't proceed
 * automatically. `formatMountRecoveryPrompt` switches on `kind` to render
 * backend-specific actionable copy.
 */
export type MountRecoveryEntry =
  | { kind: 'local'; path: string; dirName: string }
  | { kind: 's3'; path: string; source: string; profile: string; reason: string }
  | { kind: 'da'; path: string; source: string; profile: string; reason: string };

export interface MountRecoveryResult {
  /** Entries that were silently re-mounted. */
  restored: MountRecoveryEntry[];
  /** Entries that need user action to regain access. */
  needsRecovery: MountRecoveryEntry[];
}

/** Minimal FS surface needed to re-mount a backend — lets tests stub this. */
export interface MountRecoveryFS {
  mount(path: string, backend: MountBackend): Promise<void> | void;
}

/** Logger surface accepted by `recoverMounts`. Everything is optional. */
export interface MountRecoveryLogger {
  info?: (msg: string, data?: unknown) => void;
  warn?: (msg: string, data?: unknown) => void;
}

/**
 * Walk persisted mount entries and try to silently re-mount each one.
 * Local mounts that still hold readwrite permission are restored; the
 * rest land in `needsRecovery` for the cone to surface.
 *
 * Callers should only emit a session-reload lick when `needsRecovery`
 * is non-empty.
 */
export async function recoverMounts(
  entries: MountTableEntry[],
  fs: MountRecoveryFS,
  log?: MountRecoveryLogger
): Promise<MountRecoveryResult> {
  const restored: MountRecoveryEntry[] = [];
  const needsRecovery: MountRecoveryEntry[] = [];

  for (const entry of entries) {
    const { targetPath, descriptor } = entry;

    if (descriptor.kind === 'local') {
      const handle = await loadMountHandle(descriptor.idbHandleKey);
      const dirName = typeof handle?.name === 'string' ? handle.name : '';
      if (!handle || !('queryPermission' in handle)) {
        needsRecovery.push({ kind: 'local', path: targetPath, dirName });
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
          path: targetPath,
          error: err instanceof Error ? err.message : String(err),
        });
        needsRecovery.push({ kind: 'local', path: targetPath, dirName });
        continue;
      }
      if (perm !== 'granted') {
        needsRecovery.push({ kind: 'local', path: targetPath, dirName });
        continue;
      }
      try {
        const backend = LocalMountBackend.fromHandle(handle, { mountId: descriptor.mountId });
        await fs.mount(targetPath, backend);
        log?.info?.('Restored mount from previous session', { path: targetPath, name: dirName });
        restored.push({ kind: 'local', path: targetPath, dirName });
      } catch (err) {
        log?.warn?.('Failed to re-mount persisted handle', {
          path: targetPath,
          error: err instanceof Error ? err.message : String(err),
        });
        needsRecovery.push({ kind: 'local', path: targetPath, dirName });
      }
      continue;
    }

    if (descriptor.kind === 's3') {
      try {
        const store = await getDefaultSecretStore();
        const profile = await resolveS3Profile(descriptor.profile, store);
        const cache = new RemoteMountCache({ mountId: descriptor.mountId, ttlMs: 30_000 });
        const backend = new S3MountBackend({
          source: descriptor.source,
          profile: descriptor.profile,
          profileResolved: profile,
          cache,
          mountId: descriptor.mountId,
          reresolveProfile: () => resolveS3Profile(descriptor.profile, store),
        });
        await fs.mount(targetPath, backend);
        log?.info?.('Restored S3 mount from previous session', {
          path: targetPath,
          source: descriptor.source,
        });
        restored.push({
          kind: 's3',
          path: targetPath,
          source: descriptor.source,
          profile: descriptor.profile,
          reason: '', // Successfully recovered; reason is empty
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log?.warn?.('Failed to restore S3 mount', { path: targetPath, error: reason });
        needsRecovery.push({
          kind: 's3',
          path: targetPath,
          source: descriptor.source,
          profile: descriptor.profile,
          reason,
        });
      }
      continue;
    }

    if (descriptor.kind === 'da') {
      // Phase 12 wires this branch.
      needsRecovery.push({
        kind: 'da',
        path: targetPath,
        source: descriptor.source,
        profile: descriptor.profile,
        reason: 'DA backend recovery not yet implemented',
      });
      continue;
    }
  }

  return { restored, needsRecovery };
}

/**
 * POSIX single-quote shell quoting. Wraps `value` in `'…'` and escapes
 * any embedded single quotes as `'\''`. The result is a single argv
 * token, safe to paste after `mount ` regardless of spaces, globs, or
 * shell metacharacters in the path (e.g. `/mnt/My Project`, `It's`).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap `value` in a Markdown inline-code span. Newlines (illegal in
 * inline code) collapse to spaces. If the value contains backticks, the
 * delimiter grows to the smallest run that cannot collide with the
 * content, per CommonMark §6.1, so `path`s like `` `weird` `` still
 * render correctly in any downstream renderer.
 */
export function mdInlineCode(value: string): string {
  const collapsed = value.replace(/\r\n|[\r\n]/g, ' ');
  const runs = collapsed.match(/`+/g);
  const delimLen = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1;
  const delim = '`'.repeat(delimLen);
  const needsPad = collapsed.startsWith('`') || collapsed.endsWith('`');
  const body = needsPad ? ` ${collapsed} ` : collapsed;
  return `${delim}${body}${delim}`;
}

/**
 * Build a natural-language prompt for the cone describing mount points
 * that lost access on reload. Switches on `kind` to produce backend-
 * specific copy:
 *
 *   - **local**: tells the cone the user must re-grant permission via
 *     a fresh `mount <path>` (which opens the directory picker).
 *   - **s3** / **da**: includes the source URI, profile, reason, and a
 *     pre-filled `mount --source <url> --profile <p> <path>` retry hint.
 *
 * Returns `null` when there is nothing to report — callers should treat
 * a `null` result as "do not emit a lick".
 */
export function formatMountRecoveryPrompt(mounts: MountRecoveryEntry[]): string | null {
  if (!Array.isArray(mounts) || mounts.length === 0) return null;

  const noun = mounts.length === 1 ? 'mount point' : 'mount points';
  const pronoun = mounts.length === 1 ? 'it' : 'them';

  const localMounts = mounts.filter(
    (m): m is { kind: 'local'; path: string; dirName: string } => m.kind === 'local'
  );
  const remoteMounts = mounts.filter(
    (
      m
    ): m is { kind: 's3' | 'da'; path: string; source: string; profile: string; reason: string } =>
      m.kind === 's3' || m.kind === 'da'
  );

  const lines: string[] = [
    `[Session Reload] Mount recovery required for ${mounts.length} ${noun}.`,
    '',
  ];

  if (localMounts.length > 0) {
    const localListLines = localMounts.map(({ path, dirName }) => {
      const origin = dirName ? ` (previously mounted from ${mdInlineCode(dirName)})` : '';
      return `- ${mdInlineCode(path)}${origin}`;
    });
    const localCmds = localMounts.map(({ path }) => `    mount ${shellQuote(path)}`);
    lines.push(
      `The page was reloaded and the following local ${noun} lost filesystem permission. The browser cannot restore access without a fresh user gesture, so ${pronoun} cannot be used until the user re-authorizes:`,
      '',
      ...localListLines,
      '',
      'Please tell the user what happened and ask whether they want to re-mount. If yes, run the corresponding command(s) so the folder picker opens and they can re-select the same directory:',
      '',
      ...localCmds,
      ''
    );
  }

  if (remoteMounts.length > 0) {
    const remoteListLines = remoteMounts.map(({ path, source, profile, reason }) => {
      const profileFlag = profile === 'default' ? '' : ` --profile ${shellQuote(profile)}`;
      const retry = `mount --source ${shellQuote(source)}${profileFlag} ${shellQuote(path)}`;
      return `- ${mdInlineCode(path)} (${mdInlineCode(source)}, profile ${mdInlineCode(profile)}) — ${reason}\n  Retry: ${mdInlineCode(retry)}`;
    });
    lines.push(
      `The following remote ${noun} could not be auto-restored:`,
      '',
      ...remoteListLines,
      ''
    );
  }

  lines.push(
    'If the user no longer needs a mount, run `mount unmount <path>` (with the path shell-quoted the same way) to clear the stale entry instead.'
  );

  return lines.join('\n');
}
