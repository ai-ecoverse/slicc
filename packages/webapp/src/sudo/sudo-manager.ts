import sudoersDefault from '../../../vfs-root/etc/sudoers?raw';
import { createLogger } from '../base/logger.js';
import {
  APPROVALS_FILE,
  builtinScoopGrants,
  type Directive,
  directiveForKind,
  emptyPolicy,
  matchExport,
  mergePolicies,
  parseSudoers,
  SUDOERS_D_DIR,
  SUDOERS_FILE,
  type SudoersPolicy,
  sanitizeGrantPattern,
  scoopSudoersPath,
} from '../base/sudoers.js';
import type { FsWatcher } from '../fs/fs-watcher.js';
import type { VirtualFS } from '../fs/index.js';
import { GRANTED_FILE } from '../fs/sudo-fs.js';
import { FsError } from '../fs/types.js';
import type { ScoopConfig } from '../scoops/types.js';
import type { ShellSudoConfig } from '../shell/almost-bash-shell-headless.js';
import type { CapabilityBroker } from '../work-unit/capability/index.js';
import { createSudoBroker } from './index.js';
import type { SudoBroker, SudoDecision, SudoRequest } from './types.js';

const log = createLogger('sudo:manager');

export interface SudoManagerDeps {
  fs: VirtualFS;

  watcher?: FsWatcher | null;

  broker?: SudoBroker;

  capabilityBroker?: CapabilityBroker | null;

  onPolicyReload?: (folder?: string) => void;
}

function isSudoersPath(path: string): boolean {
  return path === SUDOERS_FILE || path === SUDOERS_D_DIR || path.startsWith(`${SUDOERS_D_DIR}/`);
}

const SCOOP_SUDOERS_PATH_RE = /^\/scoops\/([^/]+)\/etc\/sudoers$/;

function isScoopSudoersPath(path: string): boolean {
  return SCOOP_SUDOERS_PATH_RE.test(path);
}

function scoopFolderFromPath(path: string): string | null {
  return SCOOP_SUDOERS_PATH_RE.exec(path)?.[1] ?? null;
}

function trimTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

const LEGACY_GENERATED_HEADER =
  '# Per-scoop sudoers — generated from ScoopConfig (sandbox surface).';

const SCOOP_SUDOERS_HEADER = [
  '# Per-scoop sudoers — approved "Always" grants for this scoop.',
  '# Sandbox grants come from ScoopConfig and are registered in memory, not here.',
  '# Writes to this file always require approval (self-protected).',
  '',
].join('\n');

export function generateScoopSudoers(config?: ScoopConfig | null): string {
  const lines: string[] = [];

  const allowed = config?.allowedCommands;
  if (allowed === undefined || allowed.includes('*')) {
    lines.push('NOPASSWD Cmnd *');
  } else {
    for (const raw of allowed) {
      const safe = sanitizeGrantPattern(raw);
      if (safe) {
        lines.push(`NOPASSWD Cmnd ${safe}`);
        lines.push(`NOPASSWD Cmnd ${safe} *`);
      }
    }
  }

  for (const raw of config?.writablePaths ?? []) {
    const safe = sanitizeGrantPattern(raw);
    if (safe) {
      lines.push(`NOPASSWD Write ${trimTrailingSlash(safe)}`);
      lines.push(`NOPASSWD Write ${trimTrailingSlash(safe)}/**`);
    }
  }

  for (const raw of config?.visiblePaths ?? []) {
    const safe = sanitizeGrantPattern(raw);
    if (safe) {
      lines.push(`NOPASSWD Read ${trimTrailingSlash(safe)}`);
      lines.push(`NOPASSWD Read ${trimTrailingSlash(safe)}/**`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export class SudoManager {
  private readonly fs: VirtualFS;
  private readonly watcher: FsWatcher | null;
  private readonly broker: SudoBroker;
  private readonly onPolicyReload: (folder?: string) => void;
  private policy: SudoersPolicy = emptyPolicy();
  private unwatch: (() => void) | null = null;
  private scoopUnwatch: (() => void) | null = null;
  private reloadChain: Promise<void> = Promise.resolve();

  private scoopPolicies: Map<string, SudoersPolicy> = new Map();

  private scoopConfigPolicies: Map<string, SudoersPolicy> = new Map();

  private scoopReloadChains: Map<string, Promise<void>> = new Map();

  constructor(deps: SudoManagerDeps) {
    this.fs = deps.fs;
    this.watcher = deps.watcher ?? null;
    this.broker = deps.broker ?? createSudoBroker(deps.capabilityBroker ?? null);
    this.onPolicyReload = deps.onPolicyReload ?? (() => {});
  }

  async init(): Promise<void> {
    await this.ensureDefaults();
    await this.reload();
    this.startWatching();
  }

  getBroker(): SudoBroker {
    return this.broker;
  }

  async approve(req: SudoRequest): Promise<SudoDecision> {
    if (req.kind === 'export' && matchExport(this.policy, req.detail) === 'nopasswd-allow') {
      log.info('Export pre-granted by sudoers', { subject: req.detail });
      return { decision: 'allow' };
    }
    const decision = await this.broker.requestApproval(req);
    if (decision.decision === 'always') {
      if (req.kind === 'guest-message' || req.kind === 'guest-tool') {
        log.info('Downgrading "Always" on a guest message to a one-shot allow');
        return { decision: 'allow', attestation: decision.attestation };
      }
      const pattern = decision.pattern?.trim() || req.suggestedPattern?.trim() || req.detail;
      try {
        await this.persistGrant(directiveForKind(req.kind), pattern);
      } catch (err) {
        log.warn('Failed to persist "Always" grant; honouring as one-shot allow', {
          kind: req.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        return { decision: 'allow', attestation: decision.attestation };
      }
    }
    return decision;
  }

  getPolicy(): SudoersPolicy {
    return this.policy;
  }

  getPolicyForScoop(folder: string): SudoersPolicy {
    const local = this.scoopPolicies.get(folder);
    const config = this.scoopConfigPolicies.get(folder);
    const policies = [builtinScoopGrants(), this.policy];
    if (config) policies.push(config);
    if (local) policies.push(local);
    return mergePolicies(...policies);
  }

  registerScoopConfig(folder: string, config?: ScoopConfig | null): void {
    this.scoopConfigPolicies.set(folder, parseSudoers(generateScoopSudoers(config ?? undefined)));
    this.onPolicyReload(folder);
  }

  async initScoopPolicy(folder: string, config?: ScoopConfig | null): Promise<void> {
    this.registerScoopConfig(folder, config);
    const path = scoopSudoersPath(folder);
    let existing: string | null = null;
    try {
      if (await this.fs.exists(path)) {
        const raw = await this.fs.readFile(path, { encoding: 'utf-8' });
        existing = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      }
    } catch (err) {
      log.warn('Failed to read per-scoop sudoers during init; treating as absent', {
        folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (existing !== null && existing.split('\n', 1)[0]?.trim() === LEGACY_GENERATED_HEADER) {
      await this.fs.writeFile(path, SCOOP_SUDOERS_HEADER);
      log.info('Discarded legacy generated per-scoop sudoers (ambiguous rules, fail-closed)', {
        folder,
        path,
      });
    }
    await this.reloadScoopPolicy(folder);
  }

  async appendScoopRule(
    folder: string,
    kind: 'command' | 'read' | 'write',
    pattern: string
  ): Promise<string | null> {
    const safe = sanitizeGrantPattern(pattern);
    if (!safe) return null;
    const directive = kind === 'command' ? 'Cmnd' : kind === 'read' ? 'Read' : 'Write';
    const path = scoopSudoersPath(folder);

    let existing = '';
    try {
      if (await this.fs.exists(path)) {
        const raw = await this.fs.readFile(path, { encoding: 'utf-8' });
        existing = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      }
    } catch (err) {
      if (!(err instanceof FsError && err.code === 'ENOENT')) throw err;
    }

    const line = `NOPASSWD ${directive} ${safe}`;
    if (existing.split('\n').some((l) => l.trim() === line)) {
      log.info('Per-scoop sudoers rule already present; skipping duplicate append', {
        folder,
        kind,
        pattern: safe,
      });
      return safe;
    }
    try {
      await this.fs.mkdir(`/scoops/${folder}/etc`, { recursive: true });
    } catch {}
    const prefix = existing
      ? existing.endsWith('\n')
        ? existing
        : `${existing}\n`
      : SCOOP_SUDOERS_HEADER;
    await this.fs.writeFile(path, `${prefix}${line}\n`);
    await this.reloadScoopPolicy(folder);
    log.info('Appended per-scoop sudoers rule', { folder, kind, pattern: safe });
    return safe;
  }

  getShellConfig(opts: { transparentGating?: boolean } = {}): ShellSudoConfig {
    return {
      getPolicy: () => this.policy,
      broker: this.broker,
      persistCommandGrant: (pattern) => this.persistCommandGrant(pattern),
      transparentGating: opts.transparentGating ?? true,
    };
  }

  reload(): Promise<void> {
    this.reloadChain = this.reloadChain.then(() => this.doReload());
    return this.reloadChain;
  }

  forgetScoopPolicies(folder: string): void {
    this.scoopConfigPolicies.delete(folder);
    this.scoopPolicies.delete(folder);
    this.scoopReloadChains.delete(folder);
    this.onPolicyReload(folder);
  }

  reloadScoopPolicyByFolder(folder: string): Promise<void> {
    return this.reloadScoopPolicy(folder);
  }

  dispose(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.scoopUnwatch?.();
    this.scoopUnwatch = null;
  }

  private reloadScoopPolicy(folder: string): Promise<void> {
    const prev = this.scoopReloadChains.get(folder) ?? Promise.resolve();
    const next = prev.then(() => this.doReloadScoopPolicy(folder));
    this.scoopReloadChains.set(folder, next);
    return next;
  }

  private async doReloadScoopPolicy(folder: string): Promise<void> {
    const path = scoopSudoersPath(folder);
    try {
      if (!(await this.fs.exists(path))) {
        this.scoopPolicies.delete(folder);
        this.onPolicyReload(folder);
        return;
      }
    } catch {
      this.scoopPolicies.delete(folder);
      this.onPolicyReload(folder);
      return;
    }
    this.scoopPolicies.set(folder, await this.readPolicyFile(path));
    this.onPolicyReload(folder);
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
    } catch {}
    this.policy = mergePolicies(...policies);
    this.onPolicyReload();
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
    } catch {}
    await this.seedWhenAbsent(SUDOERS_FILE, () => sudoersDefault);

    await this.seedWhenAbsent(
      APPROVALS_FILE,
      async () => (await import('../scoops/approver-agent.js')).DEFAULT_APPROVALS_MD
    );
  }

  private async seedWhenAbsent(path: string, load: () => string | Promise<string>): Promise<void> {
    try {
      if (await this.fs.exists(path)) return;
      await this.fs.writeFile(path, await load());
      log.info('Seeded bundled policy default', { path });
    } catch (err) {
      log.warn('Failed to seed bundled policy default', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persistCommandGrant(pattern: string): Promise<void> {
    return this.persistGrant('Cmnd', pattern);
  }

  private async persistGrant(directive: Directive, pattern: string): Promise<void> {
    const safe = sanitizeGrantPattern(pattern);
    if (!safe) return;
    let existing = '';
    try {
      if (await this.fs.exists(GRANTED_FILE)) {
        const raw = await this.fs.readFile(GRANTED_FILE, { encoding: 'utf-8' });
        existing = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      }
    } catch (err) {
      if (!(err instanceof FsError && err.code === 'ENOENT')) throw err;
    }
    try {
      await this.fs.mkdir(SUDOERS_D_DIR, { recursive: true });
    } catch {}
    const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
    const pad = directive === 'Cmnd' ? '  ' : ' ';
    await this.fs.writeFile(GRANTED_FILE, `${prefix}NOPASSWD ${directive}${pad}${safe}\n`);
    await this.reload();
  }

  private startWatching(): void {
    if (!this.watcher) return;
    if (!this.unwatch) {
      this.unwatch = this.watcher.watch('/etc', isSudoersPath, () => {
        void this.reload();
      });
    }
    if (!this.scoopUnwatch) {
      this.scoopUnwatch = this.watcher.watch('/scoops', isScoopSudoersPath, (events) => {
        const folders = new Set<string>();
        for (const ev of events) {
          const folder = scoopFolderFromPath(ev.path);
          if (folder) folders.add(folder);
        }
        for (const folder of folders) {
          void this.reloadScoopPolicy(folder);
        }
      });
    }
  }
}
