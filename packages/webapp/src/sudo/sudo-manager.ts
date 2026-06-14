/**
 * SudoManager — owns the live sudoers policy + the shared approval broker.
 *
 * One manager is created per orchestrator (so per float) once the shared VFS
 * and its `FsWatcher` exist. It:
 *
 *   1. Seeds a fully commented-out default `/etc/sudoers` template on a fresh
 *      VFS (self-protection still applies even with no rules).
 *   2. Loads + merges `/etc/sudoers` and every `/etc/sudoers.d/*` drop-in into
 *      a single live `SudoersPolicy`.
 *   3. Re-reads that policy whenever those files change (after an approved
 *      write, a manual edit, or an "Always" NOPASSWD append) so config takes
 *      effect with no restart.
 *
 * `getPolicy()` returns the live snapshot — SudoFS and the command guard call
 * it per-op, so a reload is visible immediately. `getBroker()` hands out the
 * single float-appropriate broker (extension relay vs node-server HTTP).
 */

import sudoersDefault from '../../../vfs-root/etc/sudoers?raw';
import { createLogger } from '../core/logger.js';
import type { FsWatcher } from '../fs/fs-watcher.js';
import type { VirtualFS } from '../fs/index.js';
import { GRANTED_FILE } from '../fs/sudo-fs.js';
import type { ShellSudoConfig } from '../shell/almost-bash-shell-headless.js';
import {
  emptyPolicy,
  mergePolicies,
  parseSudoers,
  SUDOERS_D_DIR,
  SUDOERS_FILE,
  type SudoersPolicy,
  sanitizeGrantPattern,
} from '../shell/sudo/sudoers.js';
import { createSudoBroker } from './index.js';
import type { SudoBroker } from './types.js';

const log = createLogger('sudo:manager');

/** Dependencies for {@link SudoManager}. */
export interface SudoManagerDeps {
  /** The shared (raw) VFS handle — grant writes must bypass the FS gate. */
  fs: VirtualFS;
  /** Watcher to drive live reload. When omitted, reload is manual-only. */
  watcher?: FsWatcher | null;
  /** Override the broker (tests). Defaults to the float-appropriate broker. */
  broker?: SudoBroker;
}

/** Whether `path` is one of the (live-reload-triggering) sudoers files. */
function isSudoersPath(path: string): boolean {
  return path === SUDOERS_FILE || path === SUDOERS_D_DIR || path.startsWith(`${SUDOERS_D_DIR}/`);
}

export class SudoManager {
  private readonly fs: VirtualFS;
  private readonly watcher: FsWatcher | null;
  private readonly broker: SudoBroker;
  private policy: SudoersPolicy = emptyPolicy();
  private unwatch: (() => void) | null = null;
  private reloadChain: Promise<void> = Promise.resolve();

  constructor(deps: SudoManagerDeps) {
    this.fs = deps.fs;
    this.watcher = deps.watcher ?? null;
    this.broker = deps.broker ?? createSudoBroker();
  }

  /** Seed defaults, load the policy, and start watching for live reload. */
  async init(): Promise<void> {
    await this.ensureDefaults();
    await this.reload();
    this.startWatching();
  }

  /** The single float-appropriate approval broker. */
  getBroker(): SudoBroker {
    return this.broker;
  }

  /** The live merged policy snapshot (re-read on every change). */
  getPolicy(): SudoersPolicy {
    return this.policy;
  }

  /**
   * Command-guard config for a {@link AlmostBashShell}: gated via this manager.
   *
   * `transparentGating` controls whether every dispatched command is wrapped
   * with the `Cmnd` policy gate. Defaults to `true` (agent-shell behavior).
   * Pass `false` for the human terminal — `sudo <cmd...>` still works
   * (broker + persist sink remain wired) but plain commands run ungated.
   */
  getShellConfig(opts: { transparentGating?: boolean } = {}): ShellSudoConfig {
    return {
      getPolicy: () => this.policy,
      broker: this.broker,
      persistCommandGrant: (pattern) => this.persistCommandGrant(pattern),
      transparentGating: opts.transparentGating ?? true,
    };
  }

  /** Re-read `/etc/sudoers` + `/etc/sudoers.d/*` into the live policy. */
  reload(): Promise<void> {
    this.reloadChain = this.reloadChain.then(() => this.doReload());
    return this.reloadChain;
  }

  /** Stop watching for changes. Idempotent. */
  dispose(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  private async doReload(): Promise<void> {
    const policies: SudoersPolicy[] = [await this.readPolicyFile(SUDOERS_FILE)];
    try {
      const entries = await this.fs.readDir(SUDOERS_D_DIR);
      const names = entries
        .filter((e) => e.type === 'file')
        .map((e) => e.name)
        .sort();
      for (const name of names) {
        policies.push(await this.readPolicyFile(`${SUDOERS_D_DIR}/${name}`));
      }
    } catch {
      /* no drop-in directory yet */
    }
    this.policy = mergePolicies(...policies);
  }

  private async readPolicyFile(path: string): Promise<SudoersPolicy> {
    try {
      if (!(await this.fs.exists(path))) return emptyPolicy();
      const raw = await this.fs.readFile(path, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      return parseSudoers(text);
    } catch (err) {
      log.warn('Failed to read sudoers file; ignoring', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyPolicy();
    }
  }

  private async ensureDefaults(): Promise<void> {
    try {
      await this.fs.mkdir(SUDOERS_D_DIR, { recursive: true });
    } catch {
      /* already exists */
    }
    try {
      if (!(await this.fs.exists(SUDOERS_FILE))) {
        await this.fs.writeFile(SUDOERS_FILE, sudoersDefault);
        log.info('Seeded default /etc/sudoers template');
      }
    } catch (err) {
      log.warn('Failed to seed default /etc/sudoers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async persistCommandGrant(pattern: string): Promise<void> {
    const safe = sanitizeGrantPattern(pattern);
    if (!safe) return;
    let existing = '';
    try {
      if (await this.fs.exists(GRANTED_FILE)) {
        const raw = await this.fs.readFile(GRANTED_FILE, { encoding: 'utf-8' });
        existing = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      }
    } catch {
      existing = '';
    }
    try {
      await this.fs.mkdir(SUDOERS_D_DIR, { recursive: true });
    } catch {
      /* already exists */
    }
    const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
    await this.fs.writeFile(GRANTED_FILE, `${prefix}NOPASSWD Cmnd  ${safe}\n`);
    await this.reload();
  }

  private startWatching(): void {
    if (!this.watcher || this.unwatch) return;
    this.unwatch = this.watcher.watch('/etc', isSudoersPath, () => {
      void this.reload();
    });
  }
}
