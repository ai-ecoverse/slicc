import type { FollowerSyncManager } from '../../scoops/tray-follower-sync.js';
import type {
  TrayModelCatalogEntry,
  TrayModelSelectionState,
} from '../../scoops/tray-sync-protocol.js';
import type { ThinkingLevel } from '../../scoops/types.js';

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

/** How long to wait before asking the leader for the catalog again (#2329). */
const CATALOG_RETRY_DELAY_MS = 2000;
/** Bounded: a leader with genuinely no models must not be polled forever. */
const CATALOG_RETRY_LIMIT = 3;

type FollowerComposerMeta = HTMLElement & {
  model?: string;
  models?: Array<{ id: string; name: string; provider: string }>;
};

export function createFollowerModelSurface(opts: {
  composerMeta: FollowerComposerMeta;
  getSync: () => FollowerModelSync | null;
  getSelectedScoopJid: () => string | null;
  modelPickerEnabled?: boolean;
  interceptLocalHandlers?: boolean;
  getLockedEffortLevel?: () => string | null;
  catalogRetryDelayMs?: number;
  catalogRetryLimit?: number;
}): {
  onModelsList(models: TrayModelCatalogEntry[]): void;
  onModelState(state: TrayModelSelectionState): void;
  reset(): void;
} {
  let models: TrayModelCatalogEntry[] = [];
  let state: TrayModelSelectionState | null = null;
  const enabled = opts.modelPickerEnabled !== false;
  const retryDelayMs = opts.catalogRetryDelayMs ?? CATALOG_RETRY_DELAY_MS;
  let retriesLeft = opts.catalogRetryLimit ?? CATALOG_RETRY_LIMIT;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The picker is hidden and we cannot tell whether the leader has no models or
   * simply had none yet when we attached. Ask again, a bounded number of times
   * (#2329) — a leader too old to answer `models.request` just ignores it, and
   * one that really has no models costs three frames.
   */
  const scheduleCatalogRetry = (): void => {
    if (!enabled || retryTimer !== null || retriesLeft <= 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const sync = opts.getSync();
      if (!sync?.requestModels) return;
      retriesLeft -= 1;
      sync.requestModels();
    }, retryDelayMs);
  };

  const apply = (): void => {
    const active = state
      ? models.find((model) => model.modelId === state?.activeModelId)
      : undefined;
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
  };

  const intercept = (event: Event): void => {
    if (opts.interceptLocalHandlers) event.stopImmediatePropagation();
  };

  opts.composerMeta.addEventListener(
    'model-change',
    (event) => {
      const sync = opts.getSync();
      if (!sync) return;
      intercept(event);
      const modelId = (event as CustomEvent<{ id?: string }>).detail?.id;
      // Name the unit the pick applies to (#2310): the leader changes THAT
      // cone's model, not its own selection and not a global setting.
      const scoopJid = opts.getSelectedScoopJid() ?? state?.scoopJid;
      if (modelId) sync.selectModel(modelId, scoopJid ?? undefined);
      apply();
    },
    { capture: opts.interceptLocalHandlers }
  );

  opts.composerMeta.addEventListener(
    'thinking-change',
    (event) => {
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
    },
    { capture: opts.interceptLocalHandlers }
  );

  const reset = (): void => {
    models = [];
    state = null;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retriesLeft = opts.catalogRetryLimit ?? CATALOG_RETRY_LIMIT;
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
    reset,
  };
}
