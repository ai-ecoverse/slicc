/**
 * mount command dispatcher — routes local, S3, DA, and AEM mount requests
 * through their respective backend factories. Handles flag parsing for
 * --source, --profile, --backend, --no-probe, --max-body-mb, --clear-cache,
 * and --bodies.
 *
 * Local mounts (no --source) launch the picker UI via the local-mount
 * acquisition helpers (cone approval card + popup, extension terminal
 * popup, or standalone direct picker). The click is required to satisfy
 * Chrome's user-gesture rule for the File System Access API, not as a
 * consent gate.
 *
 * Remote mounts (s3://..., da://..., aem://...) build their backend, probe the
 * source, and mount directly — no approval ceremony, since the trust boundary
 * lives at the credential profile resolver in node-server / SW, not in the chat.
 *
 * `da://` is ambiguous by itself: a site upgraded to Helix 6 keeps its
 * `<org>/<site>` identity but moves its content off `admin.da.live`, so
 * mounting it there quietly indexes an unrelated repository (issue #2227).
 * Every `da://` mount therefore probes the site config first and re-routes to
 * the Source Bus when that is where the content lives. `--backend da|aem`
 * forces the choice when the probe is wrong or unavailable.
 *
 * Scoop fail-fast lives in {@link MountCommands.mountLocal}.
 */

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
  /**
   * Returns true when the command is running inside a non-interactive scoop
   * context. When true, local mounts fail fast. Scoops can mount S3 and DA freely.
   */
  isScoop?: () => boolean;
  /**
   * Cone-driven local mount approval. Injected by the shell layer so `fs/`
   * does not import up into `shell/` for `showToolUI`.
   */
  acquireLocalMountViaToolUI?: (
    toolContext: ToolExecutionContext,
    targetPath: string
  ) => Promise<FileSystemDirectoryHandle>;
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
  backend?: ContentBackendKind;
  noProbe: boolean;
  maxBodyMb?: number;
  clearCache: boolean;
  bodies: boolean;
  /** Set when `--backend` was given a value that isn't `da` or `aem`. */
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

/** `da://org/repo[/path]` or `aem://org/site[/path]`, split into its parts. */
interface ParsedAdobeSource {
  scheme: 'da' | 'aem';
  org: string;
  /** Repo (DA) or site (Source Bus) — the same identifier under both names. */
  name: string;
  /** Sub-path within the repo/site; '' when the whole tree is mounted. */
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
      return this.handleUnmount(args.slice(1), cwd);
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

    // Dispatch on URL scheme.
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

    // No --source → local picker.
    return this.mountLocal(targetPath, env);
  }

  // ---- handlers ----

  private async mountLocal(targetPath: string, env?: MountIndexEnv): Promise<MountCommandResult> {
    try {
      const isScoop = this.options.isScoop ?? (() => false);
      if (isScoop()) {
        throw new Error(
          'mount: cannot mount local directories from a scoop (no UI). Ask the cone.'
        );
      }
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

  /**
   * Mount an Adobe authoring source — `da://<org>/<repo>` (Helix 5
   * Document Authoring) or `aem://<org>/<site>` (Helix 6 Source Bus).
   *
   * Both speak the same IMS-bearer transport, so the only real decision is
   * *which store holds this site's content*. `aem://` states it outright.
   * `da://` does not: the scheme survived the Helix 6 upgrade even though the
   * content moved, which is how a mount can succeed against `admin.da.live`
   * and hand back a different project's boilerplate. So `da://` asks the site
   * config, and says so on stderr when the answer is the Source Bus.
   */
  private async mountAdobe(targetPath: string, parsed: ParsedArgs): Promise<MountCommandResult> {
    if (!parsed.source) {
      return this.usageError('mount: --source required');
    }
    const profileName = parsed.profile ?? 'default';
    // The IMS bearer token comes from the browser-side Adobe LLM provider on
    // each request; the transport (signedFetch) fetches it fresh per call so
    // refreshes apply. Tests inject signedFetch directly and bypass this.
    const signedFetch = this.signedFetchDa ?? makeSignedFetchDa();

    const parsedSource = parseAdobeSource(parsed.source);
    if (!parsedSource) {
      return this.usageError(
        `mount: invalid source '${parsed.source}' — expected da://org/repo or aem://org/site`
      );
    }

    let kind: ContentBackendKind = parsedSource.scheme === 'aem' ? 'aem' : 'da';
    let notice = '';
    // An explicit --backend is the user overriding the probe; an aem:// URL
    // already names its backend. Only a bare da:// needs asking.
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
        // Failing closed is the point: mounting the wrong store silently is
        // the bug this probe exists to prevent, so an unreadable config stops
        // the mount and names the escape hatch.
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
          // Reads still work via the slow per-readDir fallback; classify why the
          // index was skipped so the user gets an actionable remedy per cause.
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
          '  unmount [--clear-cache] <path>  Remove a mount point',
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
 * to the standard local-mount acquisition flow. Errors during
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
