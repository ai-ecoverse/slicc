/**
 * mount command dispatcher — routes local, S3, and DA mount requests through
 * their respective backend factories. Handles flag parsing for --source,
 * --profile, --no-probe, --max-body-mb, --clear-cache, and --bodies.
 *
 * Local mounts (no --source) launch the picker UI (cone approval / extension popup / direct).
 * Remote mounts (s3://... or da://...) dispatch through resolveS3Profile / resolveDaProfile
 * and render approval cards for cone-initiated calls (no picker integration for remotes).
 * Scoop fail-fast moved into LocalMountBackend.create().
 */

import type { VirtualFS } from './virtual-fs.js';
import { LocalMountBackend } from './mount/backend-local.js';
import { S3MountBackend } from './mount/backend-s3.js';
import { DaMountBackend } from './mount/backend-da.js';
import { RemoteMountCache } from './mount/remote-cache.js';
import {
  resolveS3Profile,
  resolveDaProfile,
  ProfileNotConfiguredError,
  getDefaultSecretStore,
  getDefaultImsClient,
  type SecretStore,
  type AdobeImsClient,
} from './mount/profile.js';
import { newMountId } from './mount/mount-id.js';
import { getToolExecutionContext, showToolUI, toolUIRegistry } from '../tools/tool-ui.js';

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
  secretStore?: SecretStore;
  imsClient?: AdobeImsClient;
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
  private secretStore?: SecretStore;
  private imsClient?: AdobeImsClient;

  constructor(private options: MountCommandsOptions) {
    this.secretStore = options.secretStore;
    this.imsClient = options.imsClient;
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

    // Resolve the store if not already injected.
    const store = this.secretStore ?? (await getDefaultSecretStore());

    let profileResolved;
    try {
      profileResolved = await resolveS3Profile(profileName, store);
    } catch (err) {
      if (err instanceof ProfileNotConfiguredError) {
        return { stdout: '', stderr: `mount: ${err.message}\n`, exitCode: 1 };
      }
      throw err;
    }

    const mountId = newMountId();
    const cache = new RemoteMountCache({ mountId, ttlMs: 30_000 });
    const backend = new S3MountBackend({
      source: parsed.source,
      profile: profileName,
      profileResolved,
      cache,
      maxBodyBytes: parsed.maxBodyMb ? parsed.maxBodyMb * 1024 * 1024 : undefined,
      mountId,
      // Auth retry: re-read secrets on 401/403 to pick up rotated creds.
      reresolveProfile: () => resolveS3Profile(profileName, store),
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

    // Cone-initiated: render approval card.
    const ctx = getToolExecutionContext();
    if (ctx) {
      const approved = await this.renderApprovalCard(
        {
          summary: `Mount S3: ${parsed.source}`,
          needsPicker: false,
        },
        ctx
      );
      if (!approved) {
        await backend.close();
        return { stdout: '', stderr: 'mount: denied by user\n', exitCode: 1 };
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

    // Resolve the IMS client if not already injected.
    const ims = this.imsClient ?? (await getDefaultImsClient());

    let profileResolved;
    try {
      profileResolved = await resolveDaProfile(profileName, ims);
    } catch (err) {
      if (err instanceof ProfileNotConfiguredError) {
        return { stdout: '', stderr: `mount: ${err.message}\n`, exitCode: 1 };
      }
      throw err;
    }

    const mountId = newMountId();
    const cache = new RemoteMountCache({ mountId, ttlMs: 30_000 });
    const backend = new DaMountBackend({
      source: parsed.source,
      profile: profileName,
      profileResolved,
      cache,
      maxBodyBytes: parsed.maxBodyMb ? parsed.maxBodyMb * 1024 * 1024 : undefined,
      mountId,
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

    // Cone-initiated: render approval card.
    const ctx = getToolExecutionContext();
    if (ctx) {
      const approved = await this.renderApprovalCard(
        {
          summary: `Mount DA: ${parsed.source}`,
          needsPicker: false,
        },
        ctx
      );
      if (!approved) {
        await backend.close();
        return { stdout: '', stderr: 'mount: denied by user\n', exitCode: 1 };
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
    const target = args[0];
    if (!target) {
      return { stdout: '', stderr: 'mount unmount: path required\n', exitCode: 1 };
    }
    const targetPath = this.resolvePath(target, cwd);

    try {
      const parsed = parseArgs(args.slice(1));
      this.options.fs.unmount(targetPath);

      // Clear cache if --clear-cache was set and the backend is remote.
      if (parsed.clearCache) {
        // Note: cache clearing happens at the RemoteMountCache level when
        // we eventually have access to the mountId. For now, we've unmounted
        // and the cache will be stale the next time we mount the same mountId.
        // A future enhancement: store mountId with the mount entry so we can
        // look it up and clear the cache explicitly.
      }

      return { stdout: `Unmounted ${targetPath}\n`, stderr: '', exitCode: 0 };
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

  private async renderApprovalCard(
    copy: { summary: string; needsPicker: boolean },
    ctx: Exclude<ReturnType<typeof getToolExecutionContext>, null>
  ): Promise<boolean> {
    const uiRequestId = toolUIRegistry.generateId();
    let timedOut = false;
    const TIMEOUT_MS = 5 * 60 * 1000;

    const rawUiPromise = showToolUI(
      {
        id: uiRequestId,
        html: `
        <div class="sprinkle-action-card">
          <div class="sprinkle-action-card__header">${copy.summary} <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>
          <div class="sprinkle-action-card__actions">
            <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
            <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve">Approve</button>
          </div>
        </div>
      `,
        onAction: async (action) => {
          if (action === 'approve') {
            return { approved: true };
          }
          return { denied: true };
        },
      },
      ctx.onUpdate
    );

    const safeUiPromise = rawUiPromise.catch((err: unknown) => {
      if (timedOut) return { timeout: true };
      throw err;
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        toolUIRegistry.cancel(uiRequestId, 'mount: timed out');
        resolve({ timeout: true });
      }, TIMEOUT_MS);
    });

    const result = await Promise.race([safeUiPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    const res = result as { approved?: boolean; denied?: boolean; timeout?: boolean };
    return res.approved === true;
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
