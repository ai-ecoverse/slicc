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
import { getToolExecutionContext, showToolUIFromContext } from '../tools/tool-ui.js';

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
}

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
      // Agent-driven: show approval UI before opening picker
      const result = await showToolUIFromContext({
        html: `
          <div class="sprinkle-action-card">
            <div class="sprinkle-action-card__header">Mount local directory <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>
            <div class="sprinkle-action-card__body">The agent wants to mount a local directory at <code>${escapeHtml(targetPath)}</code>. This will give the agent read/write access to files in the directory you select.</div>
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
      });

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
      // Extension terminal: use popup window for TCC dialog compatibility
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
      // CLI/standalone: direct picker (has user gesture, TCC dialogs work)
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
      await this.options.fs.mount(targetPath, dirHandle);
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

function openMountPickerPopup(): Promise<Record<string, unknown>> {
  const popupRequestId = `mount-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const url = chrome.runtime.getURL(
      `mount-popup.html?requestId=${encodeURIComponent(popupRequestId)}`
    );

    const cleanup = () => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ cancelled: true });
    }, 60_000);

    const listener = (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (!m || m.source !== 'mount-popup' || m.requestId !== popupRequestId) return;
      cleanup();
      resolve(m);
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.windows
      .create({ url, type: 'popup', width: 400, height: 100, focused: true })
      .catch(() => {
        cleanup();
        resolve({ error: 'Failed to open directory picker window' });
      });
  });
}

async function loadAndClearPendingHandle(
  idbKey: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('slicc-pending-mount', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  const store = tx.objectStore('handles');
  const getReq = store.get(idbKey);
  const deleteReq = store.delete(idbKey);
  deleteReq.onerror = () => {
    console.warn('[mount] Failed to delete pending handle from IDB', idbKey, deleteReq.error);
  };
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    tx.oncomplete = () => resolve(getReq.result ?? null);
    getReq.onerror = () => reject(getReq.error ?? new Error('IDB get failed'));
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
  db.close();
  return handle;
}
