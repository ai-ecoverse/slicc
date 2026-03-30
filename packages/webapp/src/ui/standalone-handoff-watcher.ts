import type { PendingHandoff } from '../../../chrome-extension/src/messages.js';
import { parseHandoffFromUrl } from '../../../chrome-extension/src/handoff-shared.js';
import type { PageInfo } from '../cdp/types.js';
import { createLogger } from '../core/logger.js';
import type { BrowserAPI } from '../cdp/index.js';
import type { CDPTransport } from '../cdp/transport.js';

interface StandaloneHandoffWatcherOptions {
  browser: BrowserAPI;
  onPendingHandoffsChange?: (handoffs: PendingHandoff[]) => void;
  reconcileIntervalMs?: number;
}

const log = createLogger('standalone-handoffs');

function compareByReceivedAt(a: PendingHandoff, b: PendingHandoff): number {
  return a.receivedAt.localeCompare(b.receivedAt);
}

export class StandaloneHandoffWatcher {
  private readonly browser: BrowserAPI;
  private readonly onPendingHandoffsChange?: (handoffs: PendingHandoff[]) => void;
  private readonly reconcileIntervalMs: number;
  private readonly targetToHandoffId = new Map<string, string>();
  private readonly targetIdsByHandoffId = new Map<string, Set<string>>();
  private readonly pendingByHandoffId = new Map<string, PendingHandoff>();
  private readonly transport: CDPTransport;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private reconciling = false;

  private readonly handleTargetCreated = (params: Record<string, unknown>): void => {
    this.handleTargetUpdate(params['targetInfo']);
  };

  private readonly handleTargetInfoChanged = (params: Record<string, unknown>): void => {
    this.handleTargetUpdate(params['targetInfo']);
  };

  private readonly handleTargetDestroyed = (params: Record<string, unknown>): void => {
    const targetId = typeof params['targetId'] === 'string' ? params['targetId'] : null;
    if (!targetId) return;
    if (this.removeTarget(targetId)) {
      this.emitChange();
    }
  };

  constructor(options: StandaloneHandoffWatcherOptions) {
    this.browser = options.browser;
    this.onPendingHandoffsChange = options.onPendingHandoffsChange;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5000;
    this.transport = this.browser.getTransport();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.transport.on('Target.targetCreated', this.handleTargetCreated);
    this.transport.on('Target.targetInfoChanged', this.handleTargetInfoChanged);
    this.transport.on('Target.targetDestroyed', this.handleTargetDestroyed);

    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.reconcileIntervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    this.transport.off('Target.targetCreated', this.handleTargetCreated);
    this.transport.off('Target.targetInfoChanged', this.handleTargetInfoChanged);
    this.transport.off('Target.targetDestroyed', this.handleTargetDestroyed);
  }

  clearHandoff(handoffId: string): { handoff: PendingHandoff | null; targetIds: string[] } {
    const handoff = this.pendingByHandoffId.get(handoffId) ?? null;
    const targetIds = [...(this.targetIdsByHandoffId.get(handoffId) ?? [])];
    if (!handoff) {
      return { handoff: null, targetIds: [] };
    }

    this.pendingByHandoffId.delete(handoffId);
    this.targetIdsByHandoffId.delete(handoffId);
    for (const targetId of targetIds) {
      this.targetToHandoffId.delete(targetId);
    }
    this.emitChange();
    return { handoff, targetIds };
  }

  private emitChange(): void {
    this.onPendingHandoffsChange?.([...this.pendingByHandoffId.values()].sort(compareByReceivedAt));
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;

    try {
      const pages = await this.browser.listPages();
      await this.enableTargetDiscovery();

      const seenTargetIds = new Set<string>();
      let changed = false;

      for (const page of pages) {
        seenTargetIds.add(page.targetId);
        changed = this.upsertTarget(page) || changed;
      }

      for (const targetId of [...this.targetToHandoffId.keys()]) {
        if (!seenTargetIds.has(targetId)) {
          changed = this.removeTarget(targetId) || changed;
        }
      }

      if (changed) this.emitChange();
    } catch (error) {
      log.warn('Failed to reconcile standalone handoffs', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async enableTargetDiscovery(): Promise<void> {
    try {
      await this.transport.send('Target.setDiscoverTargets', { discover: true });
    } catch (error) {
      log.warn('Failed to enable Target discovery for standalone handoffs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleTargetUpdate(targetInfoValue: unknown): void {
    const targetInfo = this.normalizeTargetInfo(targetInfoValue);
    if (!targetInfo) return;
    if (this.upsertTarget(targetInfo)) {
      this.emitChange();
    }
  }

  private normalizeTargetInfo(value: unknown): PageInfo | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record['type'] !== 'page') return null;
    if (typeof record['targetId'] !== 'string' || !record['targetId']) return null;
    if (typeof record['url'] !== 'string') return null;
    return {
      targetId: record['targetId'],
      title: typeof record['title'] === 'string' ? record['title'] : '',
      url: record['url'],
    };
  }

  private upsertTarget(target: PageInfo): boolean {
    const nextHandoff = parseHandoffFromUrl(target.url);
    const previousHandoffId = this.targetToHandoffId.get(target.targetId);

    if (!nextHandoff) {
      return this.removeTarget(target.targetId);
    }

    let changed = false;
    if (previousHandoffId && previousHandoffId !== nextHandoff.handoffId) {
      changed = this.removeTarget(target.targetId) || changed;
    }

    if (this.targetToHandoffId.get(target.targetId) !== nextHandoff.handoffId) {
      this.targetToHandoffId.set(target.targetId, nextHandoff.handoffId);
      changed = true;
    }

    let targetIds = this.targetIdsByHandoffId.get(nextHandoff.handoffId);
    if (!targetIds) {
      targetIds = new Set<string>();
      this.targetIdsByHandoffId.set(nextHandoff.handoffId, targetIds);
    }
    if (!targetIds.has(target.targetId)) {
      targetIds.add(target.targetId);
      changed = true;
    }

    const existingHandoff = this.pendingByHandoffId.get(nextHandoff.handoffId);
    if (!existingHandoff) {
      this.pendingByHandoffId.set(nextHandoff.handoffId, nextHandoff);
      changed = true;
    } else if (existingHandoff.sourceUrl !== nextHandoff.sourceUrl) {
      this.pendingByHandoffId.set(nextHandoff.handoffId, {
        ...existingHandoff,
        sourceUrl: nextHandoff.sourceUrl,
      });
      changed = true;
    }

    return changed;
  }

  private removeTarget(targetId: string): boolean {
    const handoffId = this.targetToHandoffId.get(targetId);
    if (!handoffId) return false;

    this.targetToHandoffId.delete(targetId);

    const targetIds = this.targetIdsByHandoffId.get(handoffId);
    if (!targetIds) return true;

    targetIds.delete(targetId);
    if (targetIds.size === 0) {
      this.targetIdsByHandoffId.delete(handoffId);
      this.pendingByHandoffId.delete(handoffId);
    }
    return true;
  }
}
