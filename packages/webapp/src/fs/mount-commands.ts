import { isExtensionRealm } from '../base/runtime-env.js';
import {
  getToolExecutionContext,
  type ToolExecutionContext,
} from '../base/tool-execution-context.js';
import { AemMountBackend } from './mount/backend-aem.js';
import { DaMountBackend, type SignedFetchDa } from './mount/backend-da.js';
import { LocalMountBackend } from './mount/backend-local.js';
import { S3MountBackend, type SignedFetchS3 } from './mount/backend-s3.js';
import { type ContentBackendKind, probeContentSource } from './mount/content-source.js';
import {
  acquireLocalMountViaDirectPicker,
  acquireLocalMountViaPopup,
} from './mount/local-mount-acquire.js';
import { newMountId } from './mount/mount-id.js';
import { RemoteMountCache } from './mount/remote-cache.js';
import { makeSignedFetchDa, makeSignedFetchS3 } from './mount/signed-fetch.js';
import type { MountIndexEnv } from './mount-index.js';
import { loadAndClearPendingHandle, reactivateHandle } from './mount-picker-popup.js';
import type { VirtualFS } from './virtual-fs.js';

export interface MountCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MountCommandsOptions {
  fs: VirtualFS;

  isScoop?: () => boolean;

  acquireLocalMountViaToolUI?: (
    toolContext: ToolExecutionContext,
    targetPath: string
  ) => Promise<FileSystemDirectoryHandle>;

  signedFetchS3?: SignedFetchS3;

  signedFetchDa?: SignedFetchDa;
}

interface ParsedArgs {
  positional: string[];
  source?: string;
  profile?: string;
  backend?: ContentBackendKind;
  noProbe: boolean;
  maxBodyMb?: number;
  clearCache: boolean;
  bodies: boolean;

  backendError?: string;
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
    } else if (a === '--backend') {
      const value = args[++i];
      if (value === 'da' || value === 'aem') out.backend = value;
      else out.backendError = value;
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

interface ParsedAdobeSource {
  scheme: 'da' | 'aem';
  org: string;

  name: string;

  path: string;
}

function parseAdobeSource(source: string): ParsedAdobeSource | null {
  const m = source.match(/^(da|aem):\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  return {
    scheme: m[1] as 'da' | 'aem',
    org: m[2],
    name: m[3],
    path: (m[4] ?? '').replace(/^\/+/, '').replace(/\/+$/, ''),
  };
}

const VALUE_FLAGS = new Set(['--source', '--profile', '--backend', '--max-body-mb']);

function isHelpRequest(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
    if (VALUE_FLAGS.has(arg)) i++;
  }
  return false;
}

type UnmountLabel = 'mount unmount' | 'umount';

function toAemSource(parsed: ParsedAdobeSource): string {
  return `aem://${parsed.org}/${parsed.name}${parsed.path ? `/${parsed.path}` : ''}`;
}

export class MountCommands {
  private signedFetchS3?: SignedFetchS3;
  private signedFetchDa?: SignedFetchDa;

  constructor(private options: MountCommandsOptions) {
    this.signedFetchS3 = options.signedFetchS3;
    this.signedFetchDa = options.signedFetchDa;
  }

  async execute(args: string[], cwd: string, env?: MountIndexEnv): Promise<MountCommandResult> {
    const sub = args[0];

    if (sub === '--help' || sub === '-h') {
      return this.help();
    }

    if (sub === 'unmount' || sub === '-u') {
      return this.handleUnmount(args.slice(1), cwd, 'mount unmount');
    }

    if (sub === 'list' || sub === '-l' || sub === '--list') {
      return this.handleList();
    }

    if (sub === 'refresh') {
      return this.handleRefresh(args.slice(1), cwd, env);
    }

    const parsed = parseArgs(args);
    if (parsed.positional.length === 0) {
      return this.usageError('mount: mount point required');
    }
    const targetPath = this.resolvePath(parsed.positional[0], cwd);

    if (parsed.backendError !== undefined) {
      return this.usageError(
        `mount: invalid --backend '${parsed.backendError}' — expected 'da' or 'aem'`
      );
    }

    if (parsed.source) {
      if (parsed.source.startsWith('s3://')) {
        return this.mountS3(targetPath, parsed);
      }
      if (parsed.source.startsWith('da://') || parsed.source.startsWith('aem://')) {
        return this.mountAdobe(targetPath, parsed);
      }
      return this.usageError(
        `mount: invalid source '${parsed.source}' — expected s3://..., da://... or aem://...`
      );
    }

    return this.mountLocal(targetPath, env);
  }

  async executeUmount(args: string[], cwd: string): Promise<MountCommandResult> {
    return this.handleUnmount(args, cwd, 'umount');
  }

  private async mountLocal(targetPath: string, env?: MountIndexEnv): Promise<MountCommandResult> {
    try {
      const isScoop = this.options.isScoop ?? (() => false);
      if (isScoop()) {
        throw new Error(
          'mount: cannot mount local directories from a scoop (no UI). Ask the cone.'
        );
      }
      const ctx = getToolExecutionContext();

      if (!ctx) {
        const preBackend = await tryAdoptPrePickedHandle(targetPath);
        if (preBackend) {
          await this.options.fs.mount(targetPath, preBackend, { env });
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
      let dirHandle: FileSystemDirectoryHandle;
      if (ctx) {
        const acquire = this.options.acquireLocalMountViaToolUI;
        if (!acquire) {
          throw new Error('mount: tool UI not available in this runtime');
        }
        dirHandle = await acquire(ctx, targetPath);
      } else if (isExtensionRealm()) {
        dirHandle = await acquireLocalMountViaPopup();
      } else {
        dirHandle = await acquireLocalMountViaDirectPicker();
      }
      const backend = LocalMountBackend.fromHandle(dirHandle, {
        mountId: newMountId(),
      });
      await this.options.fs.mount(targetPath, backend, { env });
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

  private async mountAdobe(targetPath: string, parsed: ParsedArgs): Promise<MountCommandResult> {
    if (!parsed.source) {
      return this.usageError('mount: --source required');
    }
    const profileName = parsed.profile ?? 'default';

    const signedFetch = this.signedFetchDa ?? makeSignedFetchDa();

    const parsedSource = parseAdobeSource(parsed.source);
    if (!parsedSource) {
      return this.usageError(
        `mount: invalid source '${parsed.source}' — expected da://org/repo or aem://org/site`
      );
    }

    let kind: ContentBackendKind = parsedSource.scheme === 'aem' ? 'aem' : 'da';
    let notice = '';

    if (parsed.backend) {
      kind = parsed.backend;
    } else if (parsedSource.scheme === 'da') {
      try {
        const probe = await probeContentSource(parsedSource.org, parsedSource.name, signedFetch);
        kind = probe.backend;
        if (kind === 'aem') {
          notice =
            `mount: ${parsedSource.org}/${parsedSource.name} is on Helix 6 — its content lives in ` +
            `the Source Bus at https://api.aem.live/${parsedSource.org}/sites/${parsedSource.name}/source, ` +
            `not admin.da.live. Mounting through aem://${parsedSource.org}/${parsedSource.name}. ` +
            `Pass --backend da to force the old endpoint.\n`;
        }
      } catch (err) {
        return {
          stdout: '',
          stderr:
            `mount: could not determine the content source for ${parsed.source} — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Pass --backend da or --backend aem to skip this probe.\n`,
          exitCode: 1,
        };
      }
    }

    const mountId = newMountId();
    const cache = new RemoteMountCache({ mountId, ttlMs: 30_000 });
    const backendOpts = {
      source:
        kind === 'aem'
          ? toAemSource(parsedSource)
          : `da://${parsedSource.org}/${parsedSource.name}${parsedSource.path ? `/${parsedSource.path}` : ''}`,
      profile: profileName,
      cache,
      maxBodyBytes: parsed.maxBodyMb ? parsed.maxBodyMb * 1024 * 1024 : undefined,
      mountId,
      signedFetch,
    };
    const backend =
      kind === 'aem' ? new AemMountBackend(backendOpts) : new DaMountBackend(backendOpts);

    if (!parsed.noProbe) {
      try {
        await backend.readDir('/');
      } catch (err) {
        await backend.close();
        return {
          stdout: '',
          stderr:
            notice +
            `mount: probe failed for ${backendOpts.source} — ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    }

    await this.options.fs.mount(targetPath, backend);
    const desc = backend.describe();
    return {
      stdout: `Mounted '${desc.displayName}' → ${targetPath} (profile: ${profileName})\n`,
      stderr: notice,
      exitCode: 0,
    };
  }

  private async handleUnmount(
    args: string[],
    cwd: string,
    label: UnmountLabel
  ): Promise<MountCommandResult> {
    if (isHelpRequest(args)) {
      return label === 'umount' ? this.umountHelp() : this.help();
    }

    const parsed = parseArgs(args);
    if (parsed.positional.length === 0) {
      return { stdout: '', stderr: `${label}: path required\n`, exitCode: 1 };
    }
    const targetPath = this.resolvePath(parsed.positional[0], cwd);

    try {
      let mountIdForCache: string | undefined;
      let kindForCache: 's3' | 'da' | 'aem' | undefined;
      if (parsed.clearCache) {
        const { getAllMountEntries } = await import('./mount-table-store.js');
        const entries = await getAllMountEntries();
        const entry = entries.find((e) => e.targetPath === targetPath);
        const kind = entry?.descriptor.kind;
        if (entry && (kind === 's3' || kind === 'da' || kind === 'aem')) {
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
        stderr: `${label}: ${err instanceof Error ? err.message : String(err)}\n`,
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
          switch (state.abortCause) {
            case 'depth-exceeded':
              return `${m} (index skipped: directory nesting exceeded the depth limit — reads use the slow path; raise SLICC_MOUNT_INDEX_MAX_DEPTH or 'mount unmount ${m}')`;
            case 'entries-exceeded':
              return `${m} (index skipped: mounted tree is too large — reads use the slow path; raise SLICC_MOUNT_INDEX_MAX_ENTRIES or 'mount unmount ${m}')`;
            case 'cycle-detected':
              return `${m} (index skipped: self-referential mount cycle detected — run 'mount unmount ${m}' to remove it)`;
            default:
              return `${m} (index error: ${state.error})`;
          }
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

  private async handleRefresh(
    args: string[],
    cwd: string,
    env?: MountIndexEnv
  ): Promise<MountCommandResult> {
    const parsed = parseArgs(args);
    if (parsed.positional.length === 0) {
      return { stdout: '', stderr: 'mount refresh: path required\n', exitCode: 1 };
    }
    const targetPath = this.resolvePath(parsed.positional[0], cwd);

    try {
      const report = await this.options.fs.refreshMount(targetPath, { bodies: parsed.bodies, env });
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

  private umountHelp(): MountCommandResult {
    return {
      stdout:
        [
          'Usage: umount [--clear-cache] <path>',
          '',
          'Unmount a mount point. `umount <path>` is an alias for',
          '`mount unmount <path>` — same behaviour, shorter to type.',
          '',
          'Options:',
          '  --clear-cache   Also drop cached listings and bodies for a remote mount',
          '',
          'Examples:',
          '  umount /mnt/myapp',
          '  umount --clear-cache /mnt/s3',
          '',
          'See also: mount --help, mount list',
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private help(): MountCommandResult {
    return {
      stdout:
        [
          'Usage: mount [OPTIONS] <target-path>',
          '       mount unmount [--clear-cache] <path>',
          '       mount list',
          '       mount --list',
          '       mount refresh [--bodies] <path>',
          '',
          'Mount a local directory, S3 bucket, or AEM authoring source into the',
          'virtual filesystem.',
          '',
          'Without --source, opens a directory picker (local mount). With --source, mounts',
          'a remote source (S3-compatible, da.live, or the Helix 6 Source Bus).',
          '',
          'A da:// source is checked against the site config first: sites upgraded to',
          'Helix 6 are re-routed to the Source Bus, because admin.da.live no longer',
          'holds their content. Use --backend to force either endpoint.',
          '',
          'Options:',
          '  --source <url>      Remote source: s3://bucket[/prefix], da://org/repo,',
          '                      or aem://org/site',
          '  --profile <name>    Profile name (default: "default")',
          '  --backend <da|aem>  Force the Adobe backend instead of probing the site config',
          '  --no-probe          Skip the root-level probe on mount',
          '  --max-body-mb <n>   Override body size limit (MB)',
          '',
          'Sub-commands:',
          '  unmount [--clear-cache] <path>  Remove a mount point (also spelled `umount <path>`)',
          '  list, --list, -l                Show active mount points',
          '  refresh [--bodies] <path>       Re-index or revalidate a mount',
          '',
          'Examples:',
          '  mount /mnt/myapp',
          '  mount --source s3://my-bucket --profile default /mnt/s3',
          '  mount --source da://my-org/my-repo /mnt/da',
          '  mount --source aem://my-org/my-site /mnt/aem',
          '  mount list',
          '  mount refresh /mnt/myapp',
          '  mount unmount /mnt/myapp',
          '  umount /mnt/myapp',
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }
}

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
