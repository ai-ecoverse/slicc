/**
 * LickRegistry - one map keyed by `lickId` carrying a discriminated `LickEntry`
 * for every actionable lick variant. Extracted from `Orchestrator` so the four
 * disjoint state containers (navigate-upskill / navigate-handoff /
 * session-reload-mount / session-reload-plain / upgrade) collapse to one
 * dispatch and the per-variant resolvers live next to the data they own.
 *
 * The registry stays free of cone-state coupling: side effects (running shell
 * commands in the cone, flipping the persisted lick card) are injected via
 * {@link LickRegistryDeps} so this module imports nothing from `orchestrator.ts`.
 */

import type { MountRecoveryEntry } from '../fs/mount-recovery.js';
import type { SudoDecision } from '../sudo/index.js';
import type { LickEvent } from './lick-manager.js';

export type LickEntry =
  | { kind: 'navigate-upskill'; target: string; branch?: string; path?: string }
  | { kind: 'navigate-handoff' }
  | { kind: 'session-reload-mount'; mounts: MountRecoveryEntry[] }
  | { kind: 'session-reload-plain' }
  | { kind: 'upgrade'; from: string; to: string };

export interface LickResolution {
  settled: boolean;
  persisted: boolean;
  message?: string;
}

export interface LickRegistryDeps {
  /**
   * Run `upskill <target> [--branch ..] [--path ..]` in the cone's shell and
   * return the combined stdout/stderr (or an error line) for the tool to
   * surface verbatim. The orchestrator owns the cone-shell lookup so the
   * registry stays free of cone-state coupling.
   */
  runUpskillInstall(entry: { target: string; branch?: string; path?: string }): Promise<string>;
  /**
   * Re-run the listed `mount …` commands (one per `MountRecoveryEntry`) in the
   * cone's shell and return the combined per-command output. The orchestrator
   * reconstructs each command exactly as `formatMountRecoveryPrompt` rendered
   * it.
   */
  runMountRecovery(mounts: MountRecoveryEntry[]): Promise<string>;
  /**
   * Best-effort: locate the lick's persisted `sudo-request` message, stamp
   * `lickState`, and notify the UI to re-render. Mirrors
   * `Orchestrator.persistLickDecision`.
   */
  persistLickDecision(lickId: string, decision: SudoDecision['decision']): Promise<void>;
}

function mintLickId(): string {
  return `lick-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class LickRegistry {
  private entries = new Map<string, LickEntry>();

  constructor(private deps: LickRegistryDeps) {}

  /** True when `id` is a registered handoff lick (used by the human-dip gate). */
  hasHandoff(id: string): boolean {
    return this.entries.get(id)?.kind === 'navigate-handoff';
  }

  /**
   * Mint a stable `lickId` for a navigate (handoff / upskill) lick. Upskill licks
   * are agent-actionable; handoff licks stay human-gated and are NOT resolvable
   * via {@link resolve} — they fall through to the sudo registry by design.
   * Mirrors the `lick-<ts>-<rand>` id shape used by `ConeRequestRegistry`.
   */
  registerNavigate(event: LickEvent): string {
    const id = mintLickId();
    const body = (event.body ?? {}) as Record<string, unknown>;
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

  /**
   * Mint a stable `lickId` for a session-reload lick. Mount-recovery licks
   * (non-empty `mounts`) are agent-actionable; plain reload notices are
   * dismiss-only. Empty mount-recovery payloads are dropped by the formatter,
   * so they are not registered — avoids a dangling entry.
   */
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

  /**
   * Mint a stable `lickId` for an upgrade lick. The card is a binary action:
   * `lick_confirm` triggers "Update workspace files" (the three-way merge
   * scoped to the stored `from`→`to` tags); `lick_dismiss` clears the notice.
   */
  registerUpgrade(event: LickEvent): string {
    const id = mintLickId();
    const from = (event as { upgradeFromVersion?: string }).upgradeFromVersion ?? 'unknown';
    const to = (event as { upgradeToVersion?: string }).upgradeToVersion ?? 'unknown';
    this.entries.set(id, { kind: 'upgrade', from, to });
    return id;
  }

  /**
   * Settle an agent-actionable lick. Dispatches by stored entry kind and
   * returns `null` when `id` matches no registered lick (or matches a
   * handoff, which is human-gated). The caller falls through to the sudo
   * registry in that case.
   */
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
      case 'navigate-handoff':
        return null;
    }
  }

  /**
   * Flip a human-gated navigate·handoff lick card once the user resolves the
   * approval dip. Returns `true` when `lickId` matched a pending handoff lick.
   * Called from the dip-lick routing path, NOT from the agent tools — this is
   * what preserves the human-approval gate while still letting the card show
   * ✓ on accept / muted ✗ on dismiss.
   */
  async resolveHandoffByHuman(lickId: string, accepted: boolean): Promise<boolean> {
    if (!this.hasHandoff(lickId)) return false;
    this.entries.delete(lickId);
    await this.deps.persistLickDecision(lickId, accepted ? 'allow' : 'deny');
    return true;
  }

  /**
   * On allow/always: run `upskill <target> [--branch ..] [--path ..]` in the
   * cone's shell (upskill's on-disk "already exists" check still guards
   * duplicate installs); on deny: drop.
   */
  private async resolveUpskill(
    id: string,
    entry: Extract<LickEntry, { kind: 'navigate-upskill' }>,
    decision: SudoDecision
  ): Promise<LickResolution> {
    this.entries.delete(id);
    let message: string | undefined;
    if (decision.decision !== 'deny') {
      message = await this.deps.runUpskillInstall(entry);
    }
    await this.deps.persistLickDecision(id, decision.decision);
    return { settled: true, persisted: false, message };
  }

  /**
   * On allow/always: re-run the listed `mount …` commands (reconstructed from
   * the lick body's `MountRecoveryEntry[]`) in the cone's shell, byte-for-byte
   * matching what `formatMountRecoveryPrompt` rendered. On deny: leave the
   * mounts unmounted.
   */
  private async resolveMountRecovery(
    id: string,
    entry: Extract<LickEntry, { kind: 'session-reload-mount' }>,
    decision: SudoDecision
  ): Promise<LickResolution> {
    this.entries.delete(id);
    let message: string | undefined;
    if (decision.decision !== 'deny') {
      message = await this.deps.runMountRecovery(entry.mounts);
    }
    await this.deps.persistLickDecision(id, decision.decision);
    return { settled: true, persisted: false, message };
  }

  /**
   * Plain session-reload (no mount-recovery payload). The reload already
   * completed, so these are dismiss-only acknowledgements: `lick_dismiss`
   * (deny) clears the notice and mutes the card; `lick_confirm` is a no-op
   * that leaves the entry pending and tells the agent there is nothing to
   * confirm.
   */
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

  /**
   * Binary upgrade action. On allow/always: return the merge directive so the
   * agent runs the upgrade skill's three-way merge of bundled vfs-root content
   * (scoped to the stored `from`→`to` tags); on deny: clear the notice without
   * touching any files. Reviewing the changelog is NOT handled here — it stays
   * a separate agent step the agent can run before deciding.
   */
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
      message =
        `Update workspace files: run the upgrade skill's three-way merge of bundled ` +
        `vfs-root content from v${entry.from} → v${entry.to} ` +
        `(base = v${entry.from}, theirs = v${entry.to}, ours = the user's VFS). ` +
        `Apply the per-file outcomes and present the summary; do not delete files or ` +
        `overwrite local edits without showing the result.`;
    }
    await this.deps.persistLickDecision(id, decision.decision);
    return { settled: true, persisted: false, message };
  }
}
