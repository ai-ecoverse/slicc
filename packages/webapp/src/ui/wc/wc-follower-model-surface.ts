import type { FollowerSyncManager } from '../../scoops/tray-follower-sync.js';
import type {
  TrayModelCatalogEntry,
  TrayModelSelectionState,
} from '../../scoops/tray-sync-protocol.js';
import type { ThinkingLevel, WorkUnitModel } from '../../scoops/types.js';
import { modelForUnit } from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { parseQualifiedModelId, qualifiedModelId } from '../../work-unit/record.js';

const PI_FROM_META: Readonly<Record<string, ThinkingLevel>> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

const META_FROM_PI: Readonly<Record<string, string>> = {
  off: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export function thinkingLevelForAgent(metaLevel: string | undefined): ThinkingLevel | undefined {
  return metaLevel ? PI_FROM_META[metaLevel] : undefined;
}

export function effortOverrideForAgent(metaLevel: string | undefined): string | undefined {
  return metaLevel === 'max' ? 'max' : undefined;
}

export function metaThinkingForScoop(
  level: ThinkingLevel | undefined,
  effortOverride?: string
): string {
  if (effortOverride === 'max') return 'max';
  return (level && META_FROM_PI[level]) ?? 'off';
}

type FollowerModelSync = Pick<
  FollowerSyncManager,
  'selectModel' | 'setThinkingLevel' | 'selectScoop'
> &
  Partial<Pick<FollowerSyncManager, 'requestModels'>>;

const CATALOG_RETRY_DELAY_MS = 2000;

const CATALOG_RETRY_MAX_DELAY_MS = 10_000;

const CATALOG_RETRY_WINDOW_MS = 120_000;

type FollowerComposerMeta = HTMLElement & {
  model?: string;
  models?: Array<{ id: string; name: string; provider: string }>;
};

export function createFollowerModelSurface(opts: {
  composerMeta: FollowerComposerMeta;
  getSync: () => FollowerModelSync | null;

  setModel(unitId: string, model: WorkUnitModel): void;

  getUnits: () => readonly WorkUnitSummary[];
  getSelectedScoopJid: () => string | null;
  modelPickerEnabled?: boolean;
  interceptLocalHandlers?: boolean;
  getLockedEffortLevel?: () => string | null;
  catalogRetryDelayMs?: number;
  catalogRetryMaxDelayMs?: number;
  catalogRetryWindowMs?: number;
}): {
  onModelsList(models: TrayModelCatalogEntry[]): void;
  onModelState(state: TrayModelSelectionState): void;

  onShownUnitChanged(): void;
  reset(): void;

  dispose(): void;
} {
  let models: TrayModelCatalogEntry[] = [];
  let state: TrayModelSelectionState | null = null;

  const lastKnownModel = new Map<string, WorkUnitModel>();
  const enabled = opts.modelPickerEnabled !== false;
  const retryDelayMs = opts.catalogRetryDelayMs ?? CATALOG_RETRY_DELAY_MS;
  const retryMaxDelayMs = opts.catalogRetryMaxDelayMs ?? CATALOG_RETRY_MAX_DELAY_MS;
  const retryWindowMs = opts.catalogRetryWindowMs ?? CATALOG_RETRY_WINDOW_MS;
  let retryAttempt = 0;

  let retryDeadline: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleCatalogRetry = (): void => {
    if (!enabled || retryTimer !== null) return;
    const now = Date.now();
    if (retryDeadline === null) retryDeadline = now + retryWindowMs;
    if (now >= retryDeadline) return;
    const delay = Math.min(retryDelayMs * 2 ** retryAttempt, retryMaxDelayMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const sync = opts.getSync();
      if (!sync?.requestModels) return;
      retryAttempt += 1;
      sync.requestModels();
    }, delay);
  };

  const clearCatalogRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
    retryDeadline = null;
  };

  const pruneForgottenUnits = (units: readonly WorkUnitSummary[]): void => {
    if (units.length === 0) return;
    const live = new Set(units.map((unit) => unit.id));
    for (const jid of lastKnownModel.keys()) if (!live.has(jid)) lastKnownModel.delete(jid);
  };

  const activeModelId = (): string | undefined => {
    const unitId = opts.getSelectedScoopJid();
    const units = opts.getUnits();
    pruneForgottenUnits(units);

    if (state && (units.length === 0 || !unitId)) return state.activeModelId;
    if (state && unitId && state.scoopJid === unitId) {
      const picked = parseQualifiedModelId(state.activeModelId);
      if (picked) lastKnownModel.set(unitId, picked);
      return state.activeModelId;
    }
    const known = modelForUnit(units, unitId, unitId ? lastKnownModel.get(unitId) : undefined);
    if (unitId && known) lastKnownModel.set(unitId, known);
    return known ? qualifiedModelId(known) : undefined;
  };

  const apply = (): void => {
    const wanted = activeModelId();
    const active = wanted ? models.find((model) => model.modelId === wanted) : undefined;
    if (!enabled || !state || !active) {
      opts.composerMeta.style.display = 'none';
      scheduleCatalogRetry();
      return;
    }
    opts.composerMeta.model = active.modelName;
    opts.composerMeta.setAttribute(
      'thinking',
      metaThinkingForScoop(state.thinkingLevel, state.effortOverride)
    );
    opts.composerMeta.toggleAttribute('no-thinking', !active.reasoning);
    opts.composerMeta.style.removeProperty('display');
    clearCatalogRetry();
  };

  const intercept = (event: Event): void => {
    if (opts.interceptLocalHandlers) event.stopImmediatePropagation();
  };

  const onModelChange = (event: Event): void => {
    const sync = opts.getSync();
    if (!sync) return;
    intercept(event);
    const modelId = (event as CustomEvent<{ id?: string }>).detail?.id;

    const scoopJid = opts.getSelectedScoopJid() ?? state?.scoopJid;
    const model = modelId ? parseQualifiedModelId(modelId) : null;
    if (model && scoopJid) {
      lastKnownModel.set(scoopJid, model);
      opts.setModel(scoopJid, model);
    } else if (modelId) {
      sync.selectModel(modelId, scoopJid ?? undefined);
    }
    apply();
  };
  opts.composerMeta.addEventListener('model-change', onModelChange, {
    capture: opts.interceptLocalHandlers,
  });

  const onThinkingChange = (event: Event): void => {
    const sync = opts.getSync();
    if (!sync) return;
    intercept(event);
    if (opts.getLockedEffortLevel?.()) {
      apply();
      return;
    }
    const metaLevel = (event as CustomEvent<{ thinking?: string }>).detail?.thinking;
    const thinkingLevel = thinkingLevelForAgent(metaLevel);
    const scoopJid = opts.getSelectedScoopJid() ?? state?.scoopJid;
    if (scoopJid && thinkingLevel && thinkingLevel !== 'max') {
      sync.setThinkingLevel(scoopJid, thinkingLevel, effortOverrideForAgent(metaLevel));
    }
    apply();
  };
  opts.composerMeta.addEventListener('thinking-change', onThinkingChange, {
    capture: opts.interceptLocalHandlers,
  });

  const reset = (): void => {
    models = [];
    state = null;
    lastKnownModel.clear();
    clearCatalogRetry();
    opts.composerMeta.models = [];
    opts.composerMeta.style.display = 'none';
  };
  reset();

  return {
    onModelsList(nextModels) {
      models = nextModels;
      opts.composerMeta.models = nextModels.map((model) => ({
        id: model.modelId,
        name: model.modelName,
        provider: model.providerName,
      }));
      apply();
    },
    onModelState(nextState) {
      state = nextState;
      apply();
    },

    onShownUnitChanged() {
      apply();
    },
    reset,
    dispose() {
      opts.composerMeta.removeEventListener('model-change', onModelChange, {
        capture: opts.interceptLocalHandlers,
      });
      opts.composerMeta.removeEventListener('thinking-change', onThinkingChange, {
        capture: opts.interceptLocalHandlers,
      });
      reset();

      opts.composerMeta.style.removeProperty('display');
    },
  };
}
