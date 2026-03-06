/**
 * mount command — transparently bridge a real filesystem directory into VirtualFS.
 *
 * Uses the File System Access API (showDirectoryPicker) to let the user select
 * a local directory. All reads and writes under the mount path are proxied
 * directly to the real FileSystemDirectoryHandle — no copying occurs.
 */

import type { VirtualFS } from './virtual-fs.js';

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

    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await (window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }).showDirectoryPicker({ mode: 'readwrite' });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { stdout: '', stderr: 'mount: cancelled', exitCode: 1 };
      }
      return { stdout: '', stderr: `mount: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
    }

    let targetPath: string;
    if (sub.startsWith('/')) {
      targetPath = sub;
    } else {
      targetPath = `${cwd.replace(/\/$/, '')}/${sub}`;
    }
    if (targetPath.length > 1) targetPath = targetPath.replace(/\/+$/, '');

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
