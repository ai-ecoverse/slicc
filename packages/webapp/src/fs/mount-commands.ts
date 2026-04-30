/**
 * mount command — transparently bridge a real filesystem directory into VirtualFS.
 *
 * Uses the File System Access API (showDirectoryPicker) to let the user select
 * a local directory. All reads and writes under the mount path are proxied
 * directly to the real FileSystemDirectoryHandle — no copying occurs.
 *
 * When called by the agent (no user gesture), shows an approval UI before
 * opening the file picker.
 */

import type { VirtualFS } from './virtual-fs.js';
import { getToolExecutionContext, showToolUI, toolUIRegistry } from '../tools/tool-ui.js';
import {
  openMountPickerPopup,
  loadAndClearPendingHandle,
  reactivateHandle,
} from './mount-picker-popup.js';
import { LocalMountBackend } from './mount/backend-local.js';
import { newMountId } from './mount/mount-id.js';

/** Escape HTML special characters to prevent XSS */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface MountCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MountCommandsOptions {
  fs: VirtualFS;
  /**
   * Returns true when the command is running inside a non-interactive scoop
   * context (no human at the keyboard to approve a directory picker). When
   * true, mount fails fast instead of hanging on a tool UI prompt nobody
   * will see. Omit this option in interactive (cone / standalone) contexts;
   * when omitted it is treated as undefined / not a scoop.
   */
  isScoop?: () => boolean;
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

export class MountCommands {
  constructor(private options: MountCommandsOptions) {}

  async execute(args: string[], cwd: string): Promise<MountCommandResult> {
    const sub = args[0];

    if (sub === '--help' || sub === '-h') return this.help();

    // unmount <path>
    if (sub === 'unmount' || sub === '-u') {
      const target = args[1];
      if (!target) return { stdout: '', stderr: 'mount unmount: path required', exitCode: 1 };
      const targetPath = target.startsWith('/') ? target : `${cwd.replace(/\/$/, '')}/${target}`;
      this.options.fs.unmount(targetPath);
      return { stdout: `Unmounted ${targetPath}\n`, stderr: '', exitCode: 0 };
    }

    // list mounts (no args)
    if (sub === 'list' || sub === '-l') {
      const mounts = this.options.fs.listMounts();
      if (mounts.length === 0) return { stdout: 'No active mounts\n', stderr: '', exitCode: 0 };
      const mountIndex = this.options.fs.getMountIndex();
      const lines = mounts.map((m) => {
        const state = mountIndex.getState(m);
        if (!state) return m;
        if (state.status === 'ready') {
          return `${m} (indexed: ${state.indexed} entries)`;
        } else if (state.status === 'indexing') {
          return `${m} (indexing: ${state.indexed} entries...)`;
        } else if (state.status === 'error') {
          return `${m} (index error: ${state.error})`;
        }
        return `${m} (pending index)`;
      });
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
    }

    // refresh <path> - re-index a mounted directory
    if (sub === 'refresh') {
      const target = args[1];
      if (!target) return { stdout: '', stderr: 'mount refresh: path required', exitCode: 1 };
      const targetPath = target.startsWith('/') ? target : `${cwd.replace(/\/$/, '')}/${target}`;
      try {
        await this.options.fs.refreshMount(targetPath);
        return {
          stdout: `Re-indexed ${targetPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      } catch (err) {
        return {
          stdout: '',
          stderr: `mount refresh: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    }

    // mount <target-path>
    if (!sub) {
      return {
        stdout: '',
        stderr: 'mount: mount point required\nUsage: mount <target-path>\n',
        exitCode: 1,
      };
    }

    // Fail fast when invoked from a non-interactive scoop: there is no human
    // attached to the scoop's chat to approve the picker, so the tool UI
    // would hang indefinitely. Cone (interactive) keeps the existing flow.
    if (this.options.isScoop?.()) {
      return {
        stdout: '',
        stderr:
          'mount: cannot mount from a scoop (non-interactive context). ' +
          'Ask the cone to mount the directory and share the path.\n',
        exitCode: 1,
      };
    }

    if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
      return {
        stdout: '',
        stderr: 'mount: File System Access API not available in this environment',
        exitCode: 1,
      };
    }

    // Resolve target path
    let targetPath: string;
    if (sub.startsWith('/')) {
      targetPath = sub;
    } else {
      targetPath = `${cwd.replace(/\/$/, '')}/${sub}`;
    }
    if (targetPath.length > 1) targetPath = targetPath.replace(/\/+$/, '');

    // Check if we're running in a tool context (agent-driven, no user gesture)
    const toolContext = getToolExecutionContext();
    let dirHandle: FileSystemDirectoryHandle;

    if (toolContext) {
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
            <div class="sprinkle-action-card__header">Mount at <code>${escapeHtml(targetPath)}</code> <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>
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
        toolContext.onUpdate
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
        return {
          stdout: '',
          stderr:
            `mount: timed out after ${Math.round(MOUNT_TOOL_UI_TIMEOUT_MS / 60000)} minute(s) ` +
            'waiting for user approval\n',
          exitCode: 1,
        };
      }

      if (!result) {
        return { stdout: '', stderr: 'mount: tool UI not available', exitCode: 1 };
      }

      const res = result as {
        approved?: boolean;
        handle?: FileSystemDirectoryHandle;
        denied?: boolean;
        cancelled?: boolean;
        error?: string;
      };

      if (res.denied) {
        return { stdout: '', stderr: 'mount: denied by user', exitCode: 1 };
      }
      if (res.cancelled) {
        return { stdout: '', stderr: 'mount: cancelled', exitCode: 1 };
      }
      if (res.error) {
        return { stdout: '', stderr: `mount: ${res.error}`, exitCode: 1 };
      }
      if (!res.handle) {
        return { stdout: '', stderr: 'mount: no directory selected', exitCode: 1 };
      }

      dirHandle = res.handle;
    } else if (typeof chrome !== 'undefined' && !!chrome?.runtime?.id) {
      // Extension terminal: picker must run in popup window so macOS TCC
      // dialogs render properly (side panel can't host them → renderer crash)
      try {
        const result = await openMountPickerPopup();
        if (result.cancelled) {
          return { stdout: '', stderr: 'mount: cancelled', exitCode: 1 };
        }
        if (result.error) {
          return { stdout: '', stderr: `mount: ${result.error}`, exitCode: 1 };
        }
        if (result.handleInIdb && typeof result.idbKey === 'string') {
          const handle = await loadAndClearPendingHandle(result.idbKey);
          if (!handle) {
            return {
              stdout: '',
              stderr: 'mount: no directory handle found in storage',
              exitCode: 1,
            };
          }
          await reactivateHandle(handle);
          dirHandle = handle;
        } else {
          return { stdout: '', stderr: 'mount: unexpected popup result', exitCode: 1 };
        }
      } catch (err: unknown) {
        return {
          stdout: '',
          stderr: `mount: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    } else {
      // CLI/standalone: direct picker (TCC dialogs work in regular page context)
      try {
        dirHandle = await (
          window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
        ).showDirectoryPicker({ mode: 'readwrite' });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          return { stdout: '', stderr: 'mount: cancelled', exitCode: 1 };
        }
        return {
          stdout: '',
          stderr: `mount: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    }

    try {
      const backend = LocalMountBackend.fromHandle(dirHandle, { mountId: newMountId() });
      await this.options.fs.mount(targetPath, backend);
      return {
        stdout:
          `Mounted '${dirHandle.name}' → ${targetPath}\n` +
          `Indexing in background for fast file discovery.\n` +
          `Note: External changes are not auto-detected — use 'mount refresh ${targetPath}' after modifying files outside the browser.\n`,
        stderr: '',
        exitCode: 0,
      };
    } catch (err: unknown) {
      return {
        stdout: '',
        stderr: `mount: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
  }

  private help(): MountCommandResult {
    return {
      stdout:
        [
          'Usage: mount <target-path>',
          '       mount unmount <path>',
          '       mount list',
          '       mount refresh <path>',
          '',
          'Transparently bridge a real filesystem directory into the virtual filesystem.',
          'Opens a directory picker; all reads and writes under <target-path> go directly',
          'to the real directory — no copying occurs. Changes are immediately visible on',
          'both sides. Mount points must be empty so existing VFS files are not hidden.',
          '',
          'Upon mounting, files are indexed asynchronously for fast discovery. External',
          'changes (made outside the browser) are NOT automatically detected — use',
          '`mount refresh` to re-index after external modifications.',
          '',
          'Arguments:',
          '  <target-path>  Mount point in the virtual filesystem (required).',
          '',
          'Sub-commands:',
          '  unmount <path>   Remove a mount point',
          '  list             Show active mount points and index status',
          '  refresh <path>   Re-index a mount after external changes',
          '',
          'Examples:',
          '  mount /mnt/myapp           # Mount selected dir at /mnt/myapp',
          '  mount list                 # Show active mounts with index status',
          '  mount refresh /mnt/myapp   # Re-index after external changes',
          '  mount unmount /mnt/myapp',
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }
}
