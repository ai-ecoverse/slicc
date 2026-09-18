import { type MountRecoveryEntry, shellQuote } from '../fs/mount-recovery.js';
import type { RestrictedFS } from '../fs/restricted-fs.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { AlmostBashShellHeadless } from '../shell/almost-bash-shell-headless.js';
import type { SudoDecision } from '../sudo/index.js';
import type { LickEvent } from './lick-manager.js';
import { appendLlmsTxtIgnoreHost, discoveryHostname } from './llms-txt-ignore.js';

function buildMountRecoveryCommand(entry: MountRecoveryEntry): string {
  if (entry.kind === 'local') {
    return `mount ${shellQuote(entry.path)}`;
  }
  const profileFlag = entry.profile === 'default' ? '' : ` --profile ${shellQuote(entry.profile)}`;
  return `mount --source ${shellQuote(entry.source)}${profileFlag} ${shellQuote(entry.path)}`;
}

export interface NavigateActionBody {
  verb?: unknown;
  target?: unknown;
  branch?: unknown;
  path?: unknown;
}

type LickEntry =
  | { kind: 'navigate-upskill'; target: string; branch?: string; path?: string }
  | { kind: 'navigate-handoff' }
  | { kind: 'session-reload-mount'; mounts: MountRecoveryEntry[] }
  | { kind: 'session-reload-plain' }
  | { kind: 'upgrade'; from: string; to: string }
  | { kind: 'discovery-llms-txt'; hostname: string };

export interface LickResolution {
  settled: boolean;
  persisted: boolean;
  message?: string;
}

export interface LickRegistryDeps {
  getConeShell(): AlmostBashShellHeadless | null;

  getConeFs(): VirtualFS | RestrictedFS | null;

  persistLickDecision(lickId: string, decision: SudoDecision['decision']): Promise<void>;
}

function mintLickId(): string {
  return `lick-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class LickRegistry {
  private entries = new Map<string, LickEntry>();

  constructor(private deps: LickRegistryDeps) {}

  hasHandoff(id: string): boolean {
    return this.entries.get(id)?.kind === 'navigate-handoff';
  }

  registerNavigate(event: LickEvent): string {
    const id = mintLickId();
    const body = (event.body ?? {}) as NavigateActionBody;
    const verb = typeof body.verb === 'string' ? body.verb : undefined;
    const target = typeof body.target === 'string' ? body.target : undefined;
    if (verb === 'upskill' && target) {
      this.entries.set(id, {
        kind: 'navigate-upskill',
        target,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path: typeof body.path === 'string' ? body.path : undefined,
      });
    } else if (verb === 'handoff') {
      this.entries.set(id, { kind: 'navigate-handoff' });
    }
    return id;
  }

  registerSessionReload(event: LickEvent): string {
    const id = mintLickId();
    const body = (event.body ?? {}) as { reason?: string; mounts?: MountRecoveryEntry[] };
    const mounts = Array.isArray(body.mounts) ? body.mounts : [];
    if (body.reason === 'mount-recovery') {
      if (mounts.length > 0) {
        this.entries.set(id, { kind: 'session-reload-mount', mounts });
      }
    } else {
      this.entries.set(id, { kind: 'session-reload-plain' });
    }
    return id;
  }

  registerUpgrade(event: LickEvent): string {
    const id = mintLickId();
    const from = (event as { upgradeFromVersion?: string }).upgradeFromVersion ?? 'unknown';
    const to = (event as { upgradeToVersion?: string }).upgradeToVersion ?? 'unknown';
    this.entries.set(id, { kind: 'upgrade', from, to });
    return id;
  }

  registerDiscovery(event: LickEvent): string | null {
    if (event.discoveryKind !== 'llms-txt') return null;
    const hostname = discoveryHostname(event.discoveryOrigin, event.discoveryUrl);
    if (!hostname) return null;
    const id = mintLickId();
    this.entries.set(id, { kind: 'discovery-llms-txt', hostname });
    return id;
  }

  async resolve(id: string, decision: SudoDecision): Promise<LickResolution | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    switch (entry.kind) {
      case 'navigate-upskill':
        return this.resolveUpskill(id, entry, decision);
      case 'session-reload-mount':
        return this.resolveMountRecovery(id, entry, decision);
      case 'session-reload-plain':
        return this.resolveSessionReloadPlain(id, decision);
      case 'upgrade':
        return this.resolveUpgrade(id, entry, decision);
      case 'discovery-llms-txt':
        return this.resolveDiscovery(id, entry, decision);
      case 'navigate-handoff':
        return null;
    }
  }

  async resolveHandoffByHuman(lickId: string, accepted: boolean): Promise<boolean> {
    if (!this.hasHandoff(lickId)) return false;
    this.entries.delete(lickId);
    await this.deps.persistLickDecision(lickId, accepted ? 'allow' : 'deny');
    return true;
  }

  private async resolveUpskill(
    id: string,
    entry: Extract<LickEntry, { kind: 'navigate-upskill' }>,
    decision: SudoDecision
  ): Promise<LickResolution> {
    this.entries.delete(id);
    let message: string | undefined;
    if (decision.decision !== 'deny') {
      message = await this.runUpskillInstall(entry);
    }
    await this.deps.persistLickDecision(id, decision.decision);
    return { settled: true, persisted: false, message };
  }

  private async runUpskillInstall(entry: {
    target: string;
    branch?: string;
    path?: string;
  }): Promise<string> {
    const shell = this.deps.getConeShell();
    if (!shell) return 'upskill could not run: no cone shell available.';
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const parts = ['upskill'];
    if (entry.branch) parts.push('--branch', quote(entry.branch));
    if (entry.path) parts.push('--path', quote(entry.path));
    parts.push(quote(entry.target));
    parts.push('--all');
    try {
      const result = await shell.executeCommand(parts.join(' '));
      const out = `${result.stdout}${result.stderr}`.trim();
      return out.length > 0 ? out : `upskill exited ${result.exitCode}.`;
    } catch (err) {
      return `upskill failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async resolveMountRecovery(
    id: string,
    entry: Extract<LickEntry, { kind: 'session-reload-mount' }>,
    decision: SudoDecision
  ): Promise<LickResolution> {
    this.entries.delete(id);
    let message: string | undefined;
    if (decision.decision !== 'deny') {
      message = await this.runMountRecovery(entry.mounts);
    }
    await this.deps.persistLickDecision(id, decision.decision);
    return { settled: true, persisted: false, message };
  }

  private async runMountRecovery(mounts: MountRecoveryEntry[]): Promise<string> {
    const shell = this.deps.getConeShell();
    if (!shell) return 'mount recovery could not run: no cone shell available.';
    const outputs: string[] = [];
    for (const mount of mounts) {
      const cmd = buildMountRecoveryCommand(mount);
      try {
        const result = await shell.executeCommand(cmd);
        const out = `${result.stdout}${result.stderr}`.trim();
        outputs.push(out.length > 0 ? out : `${cmd} exited ${result.exitCode}.`);
      } catch (err) {
        outputs.push(`${cmd} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return outputs.join('\n');
  }

  private async resolveSessionReloadPlain(
    id: string,
    decision: SudoDecision
  ): Promise<LickResolution> {
    if (decision.decision !== 'deny') {
      return {
        settled: true,
        persisted: false,
        message:
          'Nothing to confirm — the reload already completed. Use lick_dismiss to acknowledge and clear this notice.',
      };
    }
    this.entries.delete(id);
    await this.deps.persistLickDecision(id, 'deny');
    return { settled: true, persisted: false, message: 'Session-reload notice acknowledged.' };
  }

  private async resolveUpgrade(
    id: string,
    entry: Extract<LickEntry, { kind: 'upgrade' }>,
    decision: SudoDecision
  ): Promise<LickResolution> {
    this.entries.delete(id);
    let message: string;
    if (decision.decision === 'deny') {
      message = 'Upgrade dismissed — workspace files were left unchanged.';
    } else {
      message = await this.runUpgrade(entry);
    }
    await this.deps.persistLickDecision(id, decision.decision);
    return { settled: true, persisted: false, message };
  }

  private async resolveDiscovery(
    id: string,
    entry: Extract<LickEntry, { kind: 'discovery-llms-txt' }>,
    decision: SudoDecision
  ): Promise<LickResolution> {
    if (decision.decision !== 'deny') {
      return {
        settled: true,
        persisted: false,
        message: 'Nothing to confirm — use lick_dismiss to ignore this llms.txt host.',
      };
    }
    const fs = this.deps.getConeFs();
    if (!fs) {
      throw new Error('llms.txt dismissal could not persist: cone filesystem unavailable.');
    }
    const appended = await appendLlmsTxtIgnoreHost(fs, entry.hostname);
    this.entries.delete(id);
    await this.deps.persistLickDecision(id, 'deny');
    return {
      settled: true,
      persisted: appended,
      message: appended
        ? `Dismissed — ${entry.hostname} was added to /etc/llmstxtignore.`
        : `Dismissed — ${entry.hostname} is already ignored.`,
    };
  }

  private async runUpgrade(entry: Extract<LickEntry, { kind: 'upgrade' }>): Promise<string> {
    const shell = this.deps.getConeShell();
    if (!shell) return 'upgrade could not run: no cone shell available.';
    const command =
      `upgrade apply --from=${shellQuote(entry.from)} ` + `--to=${shellQuote(entry.to)}`;
    try {
      const result = await shell.executeCommand(command);
      const out = `${result.stdout}${result.stderr}`.trim();
      return out.length > 0 ? out : `upgrade exited ${result.exitCode}.`;
    } catch (err) {
      return `upgrade failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
