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
>;

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
}): {
  onModelsList(models: TrayModelCatalogEntry[]): void;
  onModelState(state: TrayModelSelectionState): void;
  reset(): void;
} {
  let models: TrayModelCatalogEntry[] = [];
  let state: TrayModelSelectionState | null = null;
  const enabled = opts.modelPickerEnabled !== false;

  const apply = (): void => {
    const active = state
      ? models.find((model) => model.modelId === state?.activeModelId)
      : undefined;
    if (!enabled || !state || !active) {
      opts.composerMeta.style.display = 'none';
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
