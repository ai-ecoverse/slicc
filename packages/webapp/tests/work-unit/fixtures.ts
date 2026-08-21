/**
 * Shared fixtures for the work-unit suites: record builders and an in-memory
 * {@link WorkUnitManagerHost} that records every call so adapter/manager
 * behaviour can be asserted without a real orchestrator.
 */

import { vi } from 'vitest';
import type { ScoopObserver } from '../../src/scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';
import type { WorkUnitManagerHost } from '../../src/work-unit/manager.js';

export function rootRecord(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    isCone: true,
    type: 'cone',
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-08-21T00:00:00.000Z',
    parentJid: null,
    ...overrides,
  };
}

export function childRecord(
  parentJid: string,
  overrides: Partial<RegisteredScoop> = {}
): RegisteredScoop {
  const folder = overrides.folder ?? 'worker-scoop';
  return {
    jid: `scoop_${folder}_1`,
    name: folder,
    folder,
    trigger: `@${folder}`,
    isCone: false,
    type: 'scoop',
    requiresTrigger: true,
    assistantLabel: folder,
    addedAt: '2026-08-21T00:00:01.000Z',
    parentJid,
    config: {
      visiblePaths: ['/workspace/'],
      writablePaths: [`/scoops/${folder}/`, '/shared/'],
    },
    ...overrides,
  };
}

export interface FakeHost extends WorkUnitManagerHost {
  scoops: Map<string, RegisteredScoop>;
  tabs: Map<string, ScoopTabState>;
  observers: Map<string, Set<ScoopObserver>>;
  contexts: Map<string, { getAgentMessages(): unknown[]; getContextFill(): number }>;
  /** Fire an observer event for `jid`. */
  emit<K extends keyof ScoopObserver>(
    jid: string,
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void;
  sendPrompt: ReturnType<typeof vi.fn<WorkUnitManagerHost['sendPrompt']>>;
  stopScoop: ReturnType<typeof vi.fn<WorkUnitManagerHost['stopScoop']>>;
  registerScoop: ReturnType<typeof vi.fn<WorkUnitManagerHost['registerScoop']>>;
  unregisterScoop: ReturnType<typeof vi.fn<WorkUnitManagerHost['unregisterScoop']>>;
}

export function makeFakeHost(initial: RegisteredScoop[] = []): FakeHost {
  const scoops = new Map(initial.map((s) => [s.jid, s]));
  const tabs = new Map<string, ScoopTabState>();
  const observers = new Map<string, Set<ScoopObserver>>();
  const contexts = new Map<string, { getAgentMessages(): unknown[]; getContextFill(): number }>();
  const host: FakeHost = {
    scoops,
    tabs,
    observers,
    contexts,
    emit(jid, event, ...args) {
      for (const o of observers.get(jid) ?? []) {
        (o[event] as ((...a: unknown[]) => void) | undefined)?.(...args);
      }
    },
    getScoops: () => Array.from(scoops.values()),
    getScoop: (jid) => scoops.get(jid),
    getScoopTabState: (jid) => tabs.get(jid),
    getScoopContext: (jid) => contexts.get(jid),
    sendPrompt: vi.fn(async () => {}),
    stopScoop: vi.fn(),
    registerScoop: vi.fn(async (scoop: RegisteredScoop) => {
      scoops.set(scoop.jid, scoop);
      tabs.set(scoop.jid, {
        jid: scoop.jid,
        contextId: `ctx-${scoop.jid}`,
        status: 'ready',
        lastActivity: scoop.addedAt,
      });
    }),
    unregisterScoop: vi.fn(async (jid: string) => {
      scoops.delete(jid);
      tabs.delete(jid);
      observers.delete(jid);
      contexts.delete(jid);
    }),
    observeScoop: (jid, observer) => {
      let set = observers.get(jid);
      if (!set) {
        set = new Set();
        observers.set(jid, set);
      }
      set.add(observer);
      return () => {
        set?.delete(observer);
      };
    },
  };
  return host;
}
