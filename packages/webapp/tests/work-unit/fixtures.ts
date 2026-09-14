import { vi } from 'vitest';
import { ScoopCompletionService } from '../../src/scoops/scoop-completion-service.js';
import type { ScoopObserver } from '../../src/scoops/scoop-lifecycle-manager.js';
import type { RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';
import { LiveWorkUnit, type UnitContext } from '../../src/work-unit/live-unit.js';
import type { WorkUnitManagerHost } from '../../src/work-unit/manager.js';

export function rootRecord(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
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

export function withLegacyRoleFields<T extends RegisteredScoop>(
  scoop: T,
  role: { isCone: boolean; type: 'cone' | 'scoop' }
): T {
  return Object.assign(scoop, role);
}

export interface FakeHost extends WorkUnitManagerHost {
  scoops: Map<string, RegisteredScoop>;
  units: Map<string, LiveWorkUnit>;

  emit<K extends keyof ScoopObserver>(
    jid: string,
    event: K,
    ...args: Parameters<NonNullable<ScoopObserver[K]>>
  ): void;

  setStatus(jid: string, status: ScoopTabState['status']): void;

  setContext(jid: string, context: Partial<UnitContext>): void;

  ensureLiveUnit(jid: string): LiveWorkUnit;
  sendPrompt: ReturnType<
    typeof vi.fn<
      (
        jid: string,
        text: string,
        senderId: string,
        senderName: string,
        options?: { steer?: boolean }
      ) => Promise<void>
    >
  >;
  stopScoop: ReturnType<typeof vi.fn<(jid: string) => void>>;
  registerScoop: ReturnType<typeof vi.fn<WorkUnitManagerHost['registerScoop']>>;
  persistScoop: ReturnType<typeof vi.fn<WorkUnitManagerHost['persistScoop']>>;
  reinitLiveUnit: ReturnType<typeof vi.fn<WorkUnitManagerHost['reinitLiveUnit']>>;
  rekeyConversation: ReturnType<
    typeof vi.fn<NonNullable<WorkUnitManagerHost['rekeyConversation']>>
  >;
  unregisterScoop: ReturnType<typeof vi.fn<(jid: string) => Promise<void>>>;
  waitForScoops: ReturnType<typeof vi.fn<WorkUnitManagerHost['waitForScoops']>>;

  complete(jid: string, summary: string): Promise<void>;
}

export function makeFakeHost(initial: RegisteredScoop[] = []): FakeHost {
  const scoops = new Map(initial.map((s) => [s.jid, s]));
  const units = new Map<string, LiveWorkUnit>();
  const completion = new ScoopCompletionService({
    getSharedFs: () => null,
    getScoop: (jid) => scoops.get(jid),
    findParent: (jid) => {
      const scoop = scoops.get(jid);
      return scoop?.parentJid ? scoops.get(scoop.parentJid) : undefined;
    },
    hasScoop: (jid) => scoops.has(jid),
    notifyIncomingMessage: () => {},
    handleMessage: async () => {},
    reportError: () => {},
  });
  const host: FakeHost = {
    scoops,
    units,
    emit(jid, event, ...args) {
      units.get(jid)?.dispatch(event, ...args);
    },
    setStatus(jid, status) {
      host.ensureLiveUnit(jid).transition(status);
    },
    setContext(jid, context) {
      host.ensureLiveUnit(jid).context = stubContext(jid, host, context);
    },
    getScoops: () => Array.from(scoops.values()),
    getScoop: (jid) => scoops.get(jid),
    ensureLiveUnit(jid: string): LiveWorkUnit {
      let unit = units.get(jid);
      if (!unit || unit.isClosed) {
        unit = new LiveWorkUnit(jid, {
          getScoop: (j) => scoops.get(j),
          sendPrompt: (j, text, senderId, senderName, options) =>
            host.sendPrompt(j, text, senderId, senderName, options),
          clearIdleTimer: () => {},
          forgetCompletion: (j) => completion.forgetScoop(j, 'close'),
          unregister: (j) => host.unregisterScoop(j),
        });

        unit.context = stubContext(jid, host);
        units.set(jid, unit);
      }
      return unit;
    },
    sendPrompt: vi.fn(async () => {}),
    stopScoop: vi.fn(),
    registerScoop: vi.fn(async (scoop: RegisteredScoop) => {
      scoops.set(scoop.jid, scoop);
      host.ensureLiveUnit(scoop.jid).transition('ready');
    }),
    persistScoop: vi.fn(async (scoop: RegisteredScoop) => {
      scoops.set(scoop.jid, scoop);
    }),
    reinitLiveUnit: vi.fn(async (jid: string) => {
      const unit = units.get(jid);
      if (!unit?.context) return;
      unit.disposeContext();
      unit.context = stubContext(jid, host);
      unit.transition('ready');
    }),
    rekeyConversation: vi.fn(async () => {}),
    unregisterScoop: vi.fn(async (jid: string) => {
      scoops.delete(jid);
      await units.get(jid)?.teardown();
      units.delete(jid);
    }),
    waitForScoops: vi.fn((jids, timeoutMs) => completion.waitForScoops(jids, timeoutMs)),
    complete(jid, summary) {
      completion.setResponseFull(jid, summary);
      return completion.notifyCompletion(jid);
    },
  };
  return host;
}

function stubContext(
  jid: string,
  host: FakeHost,
  overrides: Partial<UnitContext> = {}
): UnitContext {
  return {
    init: async () => {},
    stop: () => host.stopScoop(jid),
    dispose: () => {},
    getAgentMessages: () => [],
    getContextFill: () => 0,
    ...overrides,
  };
}
