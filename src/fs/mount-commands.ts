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
      return { stdout: mounts.map(m => m).join('\n') + '\n', stderr: '', exitCode: 0 };
    }

    // mount <target-path>
    if (!sub) {
      return { stdout: '', stderr: 'mount: mount point required\nUsage: mount <target-path>\n', exitCode: 1 };
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
          <div class="tool-ui">
            <p>The agent wants to mount a local directory at <code>${targetPath}</code></p>
            <p style="font-size: 0.9em; opacity: 0.8;">This will give the agent read/write access to files in the directory you select.</p>
            <div class="tool-ui__actions">
              <button class="tool-ui__btn tool-ui__btn--primary" data-action="approve">
                Select Directory
              </button>
              <button class="tool-ui__btn tool-ui__btn--secondary" data-action="deny">
                Deny
              </button>
            </div>
          </div>
        `,
        onAction: async (action) => {
          if (action === 'approve') {
            // This runs with user gesture context!
            try {
              const handle = await (window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }).showDirectoryPicker({ mode: 'readwrite' });
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

      const res = result as { approved?: boolean; handle?: FileSystemDirectoryHandle; denied?: boolean; cancelled?: boolean; error?: string };

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
    } else {
      // Terminal/interactive: direct picker (has user gesture)
      try {
        dirHandle = await (window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }).showDirectoryPicker({ mode: 'readwrite' });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          return { stdout: '', stderr: 'mount: cancelled', exitCode: 1 };
        }
        return { stdout: '', stderr: `mount: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
      }
    }

    try {
      await this.options.fs.mount(targetPath, dirHandle);
      return {
        stdout: `Mounted '${dirHandle.name}' → ${targetPath} (live bridge — reads and writes go to the real filesystem)\n`,
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
      stdout: [
        'Usage: mount <target-path>',
        '       mount unmount <path>',
        '       mount list',
        '',
        'Transparently bridge a real filesystem directory into the virtual filesystem.',
        'Opens a directory picker; all reads and writes under <target-path> go directly',
        'to the real directory — no copying occurs. Changes are immediately visible on',
        'both sides.',
        '',
        'Arguments:',
        '  <target-path>  Mount point in the virtual filesystem (required).',
        '',
        'Sub-commands:',
        '  unmount <path>  Remove a mount point',
        '  list            Show active mount points',
        '',
        'Examples:',
        '  mount /workspace/myapp   # Mount selected dir at /workspace/myapp',
        '  mount list               # Show active mounts',
        '  mount unmount /workspace/myapp',
      ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }
}
