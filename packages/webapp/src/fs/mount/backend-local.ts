/**
 * `LocalMountBackend` wraps a `FileSystemDirectoryHandle` and implements
 * `MountBackend` over the File System Access API.
 *
 * The static `create()` factory drives the picker dance — required because
 * `showDirectoryPicker()` must run inside a real user gesture, and because
 * Chrome crashes when the picker is invoked from side-panel context for
 * system directories. Three picker contexts are handled:
 *   - cone (toolContext present) — render approval card via `showToolUI`.
 *     The factory itself only ever calls `showDirectoryPicker()` inline
 *     from `onAction`; the popup detour for the extension is invisible
 *     here — the panel-side `tool-ui-renderer.ts` transparently swaps in
 *     `openMountPickerPopup` for buttons marked `data-picker="directory"`
 *     and posts back `{ handleInIdb, idbKey }`, which `create()` then
 *     resolves via `loadAndClearPendingHandle` + `reactivateHandle`.
 *   - extension terminal (no toolContext, isExtension true) — popup picker.
 *   - standalone (no toolContext, no extension) — direct picker.
 *
 * `create()` also enforces scoop fail-fast: scoops have no human at chat to
 * approve a picker, so they get an immediate error.
 */

import { FsError } from '../types.js';
import { showToolUI, toolUIRegistry, type ToolExecutionContext } from '../../tools/tool-ui.js';
import {
  openMountPickerPopup,
  loadAndClearPendingHandle,
  reactivateHandle,
} from '../mount-picker-popup.js';
import type {
  MountBackend,
  MountDirEntry,
  MountStat,
  MountDescription,
  RefreshReport,
} from './backend.js';

export interface LocalMountBackendOptions {
  mountId: string;
}

/**
 * Maximum time the agent-driven (cone) mount flow waits for the user to
 * resolve the approval / picker UI. Five minutes matches the slowest
 * realistic human response while preventing indefinite hangs.
 */
const MOUNT_TOOL_UI_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Unique sentinel returned by the timeout race so it can never be confused
 * with a legitimate tool UI result (which is `unknown`). Compared by
 * reference identity, not structural shape.
 */
const MOUNT_TIMEOUT_SENTINEL: unique symbol = Symbol('mount:timeout');

type ShowDirectoryPickerFn = (opts?: object) => Promise<FileSystemDirectoryHandle>;

export class LocalMountBackend implements MountBackend {
  readonly kind = 'local' as const;
  readonly source = undefined;
  readonly profile = undefined;
  readonly mountId: string;

  private readonly handle: FileSystemDirectoryHandle;
  private closed = false;

  private constructor(handle: FileSystemDirectoryHandle, opts: LocalMountBackendOptions) {
    this.handle = handle;
    this.mountId = opts.mountId;
  }

  static fromHandle(
    handle: FileSystemDirectoryHandle,
    opts: LocalMountBackendOptions
  ): LocalMountBackend {
    return new LocalMountBackend(handle, opts);
  }

  /**
   * Factory that handles the three picker contexts:
   *   - cone (toolContext present) — render approval card via showToolUI,
   *     then run the picker (extension uses popup, standalone uses direct)
   *   - extension terminal (no toolContext, isExtension true) — popup picker
   *   - standalone (no toolContext, no extension) — direct picker
   *
   * Scoops fail fast — there is no human at a scoop's chat to approve a
   * picker. Cone (interactive) is fine.
   */
  static async create(opts: {
    mountId: string;
    isScoop: () => boolean;
    toolContext: ToolExecutionContext | undefined;
    isExtension: boolean;
  }): Promise<LocalMountBackend> {
    if (opts.isScoop()) {
      throw new Error('mount: cannot mount local directories from a scoop (no UI). Ask the cone.');
    }

    // The picker itself only ever runs on the panel side. Cone-driven
    // mounts route through `showToolUI` → dip click → panel's
    // `handleDipPickerAction` (Phase 2b.6) → IDB. Standalone direct
    // pickers (no toolContext, no extension) need a real `window`,
    // which is checked inline at that branch. Worker contexts (kernel
    // worker) never hit the standalone branch — `toolContext` is
    // present whenever a cone-driven mount is in flight.
    let dirHandle: FileSystemDirectoryHandle;

    if (opts.toolContext) {
      // Agent-driven: show approval UI before opening picker. We drive
      // showToolUI directly (rather than the helper) so we own the request
      // id and can cancel the registry entry when the timeout fires —
      // otherwise a late click would still run the picker callback after
      // the command has already exited.
      const uiRequestId = toolUIRegistry.generateId();
      let timedOut = false;

      const rawUiPromise = showToolUI(
        {
          id: uiRequestId,
          html: `
          <div class="sprinkle-action-card">
            <div class="sprinkle-action-card__header">Mount local directory <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>
            <div class="sprinkle-action-card__actions">
              <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
              <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="directory">Select directory</button>
            </div>
          </div>
        `,
          onAction: async (action, data) => {
            if (action === 'approve') {
              const d = data as Record<string, unknown> | undefined;

              if (d?.handleInIdb && typeof d.idbKey === 'string') {
                try {
                  const handle = await loadAndClearPendingHandle(d.idbKey);
                  if (!handle) return { error: 'No directory handle found in storage' };
                  await reactivateHandle(handle);
                  return { approved: true, handle };
                } catch (err: unknown) {
                  return { error: err instanceof Error ? err.message : String(err) };
                }
              }

              if (d?.cancelled) return { cancelled: true };
              if (d?.error) return { error: String(d.error) };

              try {
                const handle = await (
                  window as Window &
                    typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
                ).showDirectoryPicker({ mode: 'readwrite' });
                return { approved: true, handle };
              } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') {
                  return { cancelled: true };
                }
                return { error: err instanceof Error ? err.message : String(err) };
              }
            }
            return { denied: true };
          },
        },
        opts.toolContext.onUpdate
      );

      // Swallow the registry rejection produced by our own cancel() call so
      // it doesn't surface as an unhandled promise rejection. Other
      // rejections (e.g. agent abort) are still observable via the race.
      const safeUiPromise = rawUiPromise.catch((err: unknown) => {
        if (timedOut) return MOUNT_TIMEOUT_SENTINEL;
        throw err;
      });

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof MOUNT_TIMEOUT_SENTINEL>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          // Cancelling rejects the pending UI, removes the registry entry,
          // and lets showToolUI emit tool_ui_done so the panel cleans up.
          toolUIRegistry.cancel(uiRequestId, 'mount: timed out');
          resolve(MOUNT_TIMEOUT_SENTINEL);
        }, MOUNT_TOOL_UI_TIMEOUT_MS);
      });

      const result = await Promise.race([safeUiPromise, timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (result === MOUNT_TIMEOUT_SENTINEL) {
        throw new Error(
          `mount: timed out after ${Math.round(MOUNT_TOOL_UI_TIMEOUT_MS / 60000)} minute(s) ` +
            'waiting for user approval'
        );
      }

      if (!result) {
        throw new Error('mount: tool UI not available');
      }

      const res = result as {
        approved?: boolean;
        handle?: FileSystemDirectoryHandle;
        denied?: boolean;
        cancelled?: boolean;
        error?: string;
      };

      if (res.denied) {
        throw new Error('mount: denied by user');
      }
      if (res.cancelled) {
        throw new Error('mount: cancelled');
      }
      if (res.error) {
        throw new Error(`mount: ${res.error}`);
      }
      if (!res.handle) {
        throw new Error('mount: no directory selected');
      }

      dirHandle = res.handle;
    } else if (opts.isExtension) {
      // Extension terminal: picker must run in popup window so macOS TCC
      // dialogs render properly (side panel can't host them → renderer crash)
      try {
        const result = await openMountPickerPopup();
        if (result.cancelled) {
          throw new Error('mount: cancelled');
        }
        if (result.error) {
          throw new Error(`mount: ${result.error}`);
        }
        if (result.handleInIdb && typeof result.idbKey === 'string') {
          const handle = await loadAndClearPendingHandle(result.idbKey);
          if (!handle) {
            throw new Error('mount: no directory handle found in storage');
          }
          await reactivateHandle(handle);
          dirHandle = handle;
        } else {
          throw new Error('mount: unexpected popup result');
        }
      } catch (err: unknown) {
        throw new Error(`mount: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // CLI/standalone: direct picker (TCC dialogs work in regular page context).
      // Worker contexts (kernel-worker mode, no `toolContext`) hit this
      // branch when a panel-terminal user types `mount --source local`
      // directly. The picker requires `window` + a recent user gesture,
      // neither of which the worker has — surface a clear error
      // pointing the user at the agent flow (which routes through
      // `showToolUI` → panel dip → `handleDipPickerAction`, all of
      // which DO have `window`).
      if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
        throw new Error(
          'mount: local picker requires a user gesture in the panel ' +
            '(unavailable in this runtime). Ask the agent to mount it instead.'
        );
      }
      try {
        dirHandle = await (
          window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
        ).showDirectoryPicker({ mode: 'readwrite' });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('mount: cancelled');
        }
        throw new Error(`mount: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return new LocalMountBackend(dirHandle, { mountId: opts.mountId });
  }

  /** Test/internal access to the underlying handle. */
  getHandle(): FileSystemDirectoryHandle {
    return this.handle;
  }

  // --- internal helpers ---

  private assertOpen(path: string): void {
    if (this.closed) {
      throw new FsError('EBADF', 'mount closed', path);
    }
  }

  private splitPath(path: string): string[] {
    return path
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .split('/')
      .filter((s) => s.length > 0);
  }

  private async resolveDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const segments = this.splitPath(path);
    let dir = this.handle;
    for (const seg of segments) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        throw this.toFsError(err, path);
      }
    }
    return dir;
  }

  private async resolveFile(path: string, create = false): Promise<FileSystemFileHandle> {
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EISDIR', 'is a directory', path);
    }
    const fileName = segments.pop()!;
    let dir = this.handle;
    for (const seg of segments) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch (err) {
        throw this.toFsError(err, path);
      }
    }
    try {
      return await dir.getFileHandle(fileName, { create });
    } catch (err) {
      throw this.toFsError(err, path);
    }
  }

  private toFsError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    if (err instanceof DOMException) {
      if (err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatchError') return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'NotAllowedError') return new FsError('EACCES', 'permission denied', path);
      // FSA throws InvalidModificationError from removeEntry() when the
      // target is a non-empty directory and `recursive` was not requested.
      // Surface that as ENOTEMPTY so callers (notably isomorphic-git's
      // checkout/reset cleanup path) can tolerate untracked files.
      if (err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    // Mock helpers may throw a plain Error with name='NotFound' (no -Error suffix).
    if (err instanceof Error) {
      if (err.name === 'NotFound' || err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatch' || err.name === 'TypeMismatchError')
        return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'InvalidModification' || err.name === 'InvalidModificationError')
        return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    return new FsError('EINVAL', err instanceof Error ? err.message : String(err), path);
  }

  // --- MountBackend implementation ---

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const dir = await this.resolveDir(path);
    const out: MountDirEntry[] = [];
    for await (const [name, child] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (child.kind === 'file') {
        const file = await (child as FileSystemFileHandle).getFile();
        out.push({ name, kind: 'file', size: file.size, lastModified: file.lastModified });
      } else {
        out.push({ name, kind: 'directory' });
      }
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.assertOpen(path);
    const fh = await this.resolveFile(path, true);
    const writable = await fh.createWritable();
    // TS 5.7 narrowed BufferSource's ArrayBufferLike to ArrayBuffer; our
    // Uint8Array may carry a SharedArrayBuffer in the type, so cast.
    await writable.write(body as unknown as BufferSource);
    await writable.close();
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      return { kind: 'directory', size: 0, mtime: 0 };
    }
    // Try as a file first. Any failure (ENOENT, ENOTDIR, EISDIR, etc.) is
    // fine — fall through to the directory check, which will succeed if
    // the path is a directory and produce the correct ENOENT otherwise.
    try {
      const fh = await this.resolveFile(path);
      const file = await fh.getFile();
      return { kind: 'file', size: file.size, mtime: file.lastModified };
    } catch {
      // fall through
    }
    await this.resolveDir(path); // throws ENOENT if missing
    return { kind: 'directory', size: 0, mtime: 0 };
  }

  async mkdir(path: string): Promise<void> {
    this.assertOpen(path);
    await this.resolveDir(path, true);
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.assertOpen(path);
    const segments = this.splitPath(path);
    if (segments.length === 0) {
      throw new FsError('EINVAL', 'cannot remove mount root', path);
    }
    const name = segments.pop()!;
    const parentPath = segments.join('/');
    const parent = await this.resolveDir(parentPath || '/');
    try {
      await (
        parent as unknown as {
          removeEntry: (n: string, o?: { recursive?: boolean }) => Promise<void>;
        }
      ).removeEntry(name, { recursive: opts?.recursive ?? false });
    } catch (err) {
      throw this.toFsError(err, path);
    }
  }

  async refresh(): Promise<RefreshReport> {
    // Local mounts have no body cache to revalidate; refresh is a no-op
    // beyond what `MountIndex` does (re-walk for fast-discovery cache).
    // `MountIndex` re-walking lives in mount-index.ts and is triggered by
    // virtual-fs.ts; not the backend's job to drive it.
    this.assertOpen('/');
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: this.handle.name };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
