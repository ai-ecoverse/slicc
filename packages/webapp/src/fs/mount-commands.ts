/**
 * mount command dispatcher — routes local, S3, and DA mount requests through
 * their respective backend factories. Handles flag parsing for --source,
 * --profile, --no-probe, --max-body-mb, --clear-cache, and --bodies.
 *
 * Local mounts (no --source) launch the picker UI via LocalMountBackend.create
 * (cone approval card + popup, extension terminal popup, or standalone direct
 * picker). The click is required to satisfy Chrome's user-gesture rule for the
 * File System Access API, not as a consent gate.
 *
 * Remote mounts (s3://... or da://...) build their backend, probe the source,
 * and mount directly — no approval ceremony, since the trust boundary lives at
 * the credential profile resolver in node-server / SW, not in the chat.
 *
 * Scoop fail-fast lives in LocalMountBackend.create().
 */

import type { VirtualFS } from './virtual-fs.js';
import { LocalMountBackend } from './mount/backend-local.js';
import { S3MountBackend, type SignedFetchS3 } from './mount/backend-s3.js';
import { DaMountBackend, type SignedFetchDa } from './mount/backend-da.js';
import { RemoteMountCache } from './mount/remote-cache.js';
import { makeSignedFetchS3, makeSignedFetchDa } from './mount/signed-fetch.js';
import { newMountId } from './mount/mount-id.js';
import { getToolExecutionContext } from '../tools/tool-ui.js';
import { loadAndClearPendingHandle, reactivateHandle } from './mount-picker-popup.js';

export interface MountCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MountCommandsOptions {
  fs: VirtualFS;
  /**
   * Returns true when the command is running inside a non-interactive scoop
   * context. When true, local mounts fail fast (scoop guard is now in
   * LocalMountBackend.create). Scoops can mount S3 and DA freely.
   */
  isScoop?: () => boolean;
  /**
   * Test override for the S3 transport. Production builds the default at
   * mount time via `makeSignedFetchS3(profile)`.
   */
  signedFetchS3?: SignedFetchS3;
  /** Test override for the DA transport. */
  signedFetchDa?: SignedFetchDa;
}

interface ParsedArgs {
  positional: string[];
  source?: string;
  profile?: string;
  noProbe: boolean;
  maxBodyMb?: number;
  clearCache: boolean;
  bodies: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    positional: [],
    noProbe: false,
    clearCache: false,
    bodies: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') {
      out.source = args[++i];
    } else if (a === '--profile') {
      out.profile = args[++i];
    } else if (a === '--no-probe') {
      out.noProbe = true;
    } else if (a === '--max-body-mb') {
      out.maxBodyMb = Number(args[++i]);
    } else if (a === '--clear-cache') {
      out.clearCache = true;
    } else if (a === '--bodies') {
      out.bodies = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

export class MountCommands {
  private signedFetchS3?: SignedFetchS3;
  private signedFetchDa?: SignedFetchDa;

  constructor(private options: MountCommandsOptions) {
    this.signedFetchS3 = options.signedFetchS3;
    this.signedFetchDa = options.signedFetchDa;
  }

  async execute(args: string[], cwd: string): Promise<MountCommandResult> {
    const sub = args[0];

    if (sub === '--help' || sub === '-h') {
      return this.help();
    }

    if (sub === 'unmount' || sub === '-u') {
      return this.handleUnmount(args.slice(1), cwd);
    }

    if (sub === 'list' || sub === '-l') {
      return this.handleList();
    }

    if (sub === 'refresh') {
      return this.handleRefresh(args.slice(1), cwd);
    }

    const parsed = parseArgs(args);
    if (parsed.positional.length === 0) {
      return this.usageError('mount: mount point required');
    }
    const targetPath = this.resolvePath(parsed.positional[0], cwd);

    // Dispatch on URL scheme.
    if (parsed.source) {
      if (parsed.source.startsWith('s3://')) {
        return this.mountS3(targetPath, parsed);
      }
      if (parsed.source.startsWith('da://')) {
        return this.mountDa(targetPath, parsed);
      }
      return this.usageError(
        `mount: invalid source '${parsed.source}' — expected s3://... or da://...`
      );
    }

    // No --source → local picker.
    return this.mountLocal(targetPath);
  }

  // ---- handlers ----

  private async mountLocal(targetPath: string): Promise<MountCommandResult> {
    try {
      const isScoop = this.options.isScoop ?? (() => false);
      const ctx = getToolExecutionContext();
      // Panel-terminal pre-intercept fast path. When the user types
      // `mount <target>` in the panel terminal in worker mode,
      // `RemoteTerminalView` runs `showDirectoryPicker` on the
      // keystroke gesture (which the worker doesn't have) and
      // stashes the granted handle under
      // `pendingMount:term:<target>`. We adopt that here and skip
      // the picker dance entirely. The IDB lookup only fires when
      // there's NO `toolContext` — the cone always goes through
      // `showToolUI` (its picker has separate user-gesture
      // plumbing in the dip), so we don't perturb its timing.
      if (!ctx) {
        const preBackend = await tryAdoptPrePickedHandle(targetPath);
        if (preBackend) {
          await this.options.fs.mount(targetPath, preBackend);
          const desc = preBackend.describe();
          return {
            stdout:
              `Mounted '${desc.displayName}' → ${targetPath}\n` +
              `Indexing in background for fast file discovery.\n` +
              `Note: External changes are not auto-detected — use 'mount refresh ${targetPath}' after modifying files outside the browser.\n`,
            stderr: '',
            exitCode: 0,
          };
        }
      }
      const backend = await LocalMountBackend.create({
        mountId: newMountId(),
        isScoop,
        toolContext: ctx ?? undefined,
        isExtension: typeof chrome !== 'undefined' && !!chrome?.runtime?.id,
      });
      await this.options.fs.mount(targetPath, backend);
      const desc = backend.describe();
      return {
        stdout:
          `Mounted '${desc.displayName}' → ${targetPath}\n` +
          `Indexing in background for fast file discovery.\n` +
          `Note: External changes are not auto-detected — use 'mount refresh ${targetPath}' after modifying files outside the browser.\n`,
        stderr: '',
        exitCode: 0,
      };
    } catch (err: unknown) {
      return {
        stdout: '',
        stderr: `mount: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  private async mountS3(targetPath: string, parsed: ParsedArgs): Promise<MountCommandResult> {
    if (!parsed.source) {
      return this.usageError('mount: --source required');
    }
    const profileName = parsed.profile ?? 'default';

    // Profile resolution is server-side — node-server's
    // /api/s3-sign-and-forward (or the SW handler in extension mode) reads
    // s3.<profile>.* fresh on every call. Browser holds no credentials.
    // The mount-time probe (below) surfaces ProfileNotConfiguredError as a
    // 4xx through the transport, which signedFetch maps to FsError(EACCES).

    const mountId = newMountId();
    const cache = new RemoteMountCache({ mountId, ttlMs: 30_000 });
    const backend = new S3MountBackend({
      source: parsed.source,
      profile: profileName,
      cache,
      maxBodyBytes: parsed.maxBodyMb ? parsed.maxBodyMb * 1024 * 1024 : undefined,
      mountId,
      signedFetch: this.signedFetchS3 ?? makeSignedFetchS3(profileName),
    });

    if (!parsed.noProbe) {
      // Probe: read the root listing once. Any 4xx fails the mount.
      try {
        await backend.readDir('/');
      } catch (err) {
        await backend.close();
        return {
          stdout: '',
          stderr: `mount: probe failed for ${parsed.source} — ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    await this.options.fs.mount(targetPath, backend);
    const desc = backend.describe();
    return {
      stdout: `Mounted '${desc.displayName}' → ${targetPath} (profile: ${profileName})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async mountDa(targetPath: string, parsed: ParsedArgs): Promise<MountCommandResult> {
    if (!parsed.source) {
      return this.usageError('mount: --source required');
    }
    const profileName = parsed.profile ?? 'default';

    // The IMS bearer token comes from the browser-side Adobe LLM provider on
    // each request; the transport (signedFetch) fetches it fresh per call so
    // refreshes apply. Tests inject signedFetch directly and bypass this.

    const mountId = newMountId();
    const cache = new RemoteMountCache({ mountId, ttlMs: 30_000 });
    const backend = new DaMountBackend({
      source: parsed.source,
      profile: profileName,
      cache,
      maxBodyBytes: parsed.maxBodyMb ? parsed.maxBodyMb * 1024 * 1024 : undefined,
      mountId,
      signedFetch: this.signedFetchDa ?? makeSignedFetchDa(),
    });

    if (!parsed.noProbe) {
      try {
        await backend.readDir('/');
      } catch (err) {
        await backend.close();
        return {
          stdout: '',
          stderr: `mount: probe failed for ${parsed.source} — ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    await this.options.fs.mount(targetPath, backend);
    const desc = backend.describe();
    return {
      stdout: `Mounted '${desc.displayName}' → ${targetPath} (profile: ${profileName})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async handleUnmount(args: string[], cwd: string): Promise<MountCommandResult> {
    // Parse the full arg list so flags can appear before or after the path.
    // Spec syntax: `mount unmount [--clear-cache] <target-path>`.
    const parsed = parseArgs(args);
    if (parsed.positional.length === 0) {
      return { stdout: '', stderr: 'mount unmount: path required\n', exitCode: 1 };
    }
    const targetPath = this.resolvePath(parsed.positional[0], cwd);

    try {
      // Look up the descriptor BEFORE unmount so we keep the mountId for
      // cache clearing. After unmount the entry is gone from the table.
      let mountIdForCache: string | undefined;
      let kindForCache: 's3' | 'da' | undefined;
      if (parsed.clearCache) {
        const { getAllMountEntries } = await import('./mount-table-store.js');
        const entries = await getAllMountEntries();
        const entry = entries.find((e) => e.targetPath === targetPath);
        if (entry && (entry.descriptor.kind === 's3' || entry.descriptor.kind === 'da')) {
          mountIdForCache = entry.descriptor.mountId;
          kindForCache = entry.descriptor.kind;
        }
      }

      await this.options.fs.unmount(targetPath);

      let cacheCleared = '';
      if (parsed.clearCache && mountIdForCache && kindForCache) {
        const { RemoteMountCache } = await import('./mount/remote-cache.js');
        const cache = new RemoteMountCache({ mountId: mountIdForCache, ttlMs: 30_000 });
        await cache.clearMount();
        cacheCleared = ` (cache cleared)`;
      } else if (parsed.clearCache) {
        // Local mount or descriptor missing — clear-cache is a no-op.
        cacheCleared = ` (no remote cache to clear)`;
      }

      return {
        stdout: `Unmounted ${targetPath}${cacheCleared}\n`,
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `mount unmount: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  private async handleList(): Promise<MountCommandResult> {
    try {
      const mounts = this.options.fs.listMounts();
      if (mounts.length === 0) {
        return { stdout: 'No active mounts\n', stderr: '', exitCode: 0 };
      }
      const mountIndex = this.options.fs.getMountIndex();
      const lines = mounts.map((m) => {
        const state = mountIndex.getState(m);
        if (!state) {
          return m;
        }
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
    } catch (err) {
      return {
        stdout: '',
        stderr: `mount list: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  private async handleRefresh(args: string[], cwd: string): Promise<MountCommandResult> {
    const parsed = parseArgs(args);
    if (parsed.positional.length === 0) {
      return { stdout: '', stderr: 'mount refresh: path required\n', exitCode: 1 };
    }
    const targetPath = this.resolvePath(parsed.positional[0], cwd);

    try {
      const report = await this.options.fs.refreshMount(targetPath, { bodies: parsed.bodies });
      const summary = `Refreshed ${targetPath}: +${report.added.length} -${report.removed.length} ~${report.changed.length} (${report.unchanged} unchanged, ${report.errors.length} errors)\n`;
      const errLines = report.errors.map((e) => `  ${e.path}: ${e.message}\n`).join('');
      return {
        stdout: summary,
        stderr: errLines,
        exitCode: report.errors.length > 0 ? 1 : 0,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `mount refresh: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  private resolvePath(target: string, cwd: string): string {
    let path: string;
    if (target.startsWith('/')) {
      path = target;
    } else {
      path = `${cwd.replace(/\/$/, '')}/${target}`;
    }
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path;
  }

  private usageError(message: string): MountCommandResult {
    return {
      stdout: '',
      stderr: `${message}\n`,
      exitCode: 1,
    };
  }

  private help(): MountCommandResult {
    return {
      stdout:
        [
          'Usage: mount [OPTIONS] <target-path>',
          '       mount unmount [--clear-cache] <path>',
          '       mount list',
          '       mount refresh [--bodies] <path>',
          '',
          'Mount a local directory, S3 bucket, or DA repository into the virtual filesystem.',
          '',
          'Without --source, opens a directory picker (local mount). With --source, mounts',
          'a remote source (S3-compatible or da.live).',
          '',
          'Options:',
          '  --source <url>      Remote source: s3://bucket[/prefix] or da://org/repo',
          '  --profile <name>    Profile name (default: "default")',
          '  --no-probe          Skip the root-level probe on mount',
          '  --max-body-mb <n>   Override body size limit (MB)',
          '',
          'Sub-commands:',
          '  unmount [--clear-cache] <path>  Remove a mount point',
          '  list                            Show active mount points',
          '  refresh [--bodies] <path>       Re-index or revalidate a mount',
          '',
          'Examples:',
          '  mount /mnt/myapp',
          '  mount --source s3://my-bucket --profile default /mnt/s3',
          '  mount --source da://my-org/my-repo /mnt/da',
          '  mount list',
          '  mount refresh /mnt/myapp',
          '  mount unmount /mnt/myapp',
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }
}

/**
 * Look up a pre-picked directory handle stashed by the panel
 * terminal under `pendingMount:term:<targetPath>`. The panel ran
 * `showDirectoryPicker` on the user's Enter keystroke gesture
 * (which the worker can't do — no `window`), so this side just
 * adopts the handle.
 *
 * Returns `null` when no pending handle exists; caller falls back
 * to the standard `LocalMountBackend.create` flow. Errors during
 * adoption (permission revoked, handle stale) also return `null`
 * so the standard flow can produce a uniform error message — the
 * pre-pick is a fast path, not a hard requirement.
 *
 * Key format MUST stay aligned with `localMountIdbKey` in
 * `kernel/remote-terminal-view.ts`. Both must change together.
 */
async function tryAdoptPrePickedHandle(targetPath: string): Promise<LocalMountBackend | null> {
  const idbKey = `pendingMount:term:${targetPath}`;
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await loadAndClearPendingHandle(idbKey);
  } catch {
    return null;
  }
  if (!handle) return null;
  try {
    await reactivateHandle(handle);
  } catch {
    return null;
  }
  return LocalMountBackend.fromHandle(handle, { mountId: newMountId() });
}
