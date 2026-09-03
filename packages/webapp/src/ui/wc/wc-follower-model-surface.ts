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

/** First wait before asking the leader for the catalog again (#2329). */
const CATALOG_RETRY_DELAY_MS = 2000;
/** Ceiling for the backoff, so a long wait stays responsive when it resolves. */
const CATALOG_RETRY_MAX_DELAY_MS = 10_000;
/**
 * How long to keep asking. Bounded by TIME, not by a try count: three tries at
 * a flat 2 s gave up after six seconds, and a leader whose provider composition
 * lands later than that was never asked again — the picker then stayed hidden
 * for the session. Observed as a ~1-in-7 cold-start failure of the two-instance
 * e2e even after #2330 (see #2329). A window plus backoff costs a handful of
 * frames against a leader that genuinely has no models, and stops entirely once
 * the pill resolves.
 */
const CATALOG_RETRY_WINDOW_MS = 120_000;

type FollowerComposerMeta = HTMLElement & {
  model?: string;
  models?: Array<{ id: string; name: string; provider: string }>;
};

export function createFollowerModelSurface(opts: {
  composerMeta: FollowerComposerMeta;
  getSync: () => FollowerModelSync | null;
  /**
   * Apply a model pick to ONE named unit (#2310/#2382).
   *
   * Required rather than derived from `getSync()`, because the two callers
   * reach the leader differently: the dedicated follower mount writes through
   * its `RemoteWorkUnitClient`, while the leader-capable float in `wc-tray.ts`
   * has no remote client of its own yet and sends the frame directly. The
   * surface itself only ever knows "this unit, this model".
   */
  setModel(unitId: string, model: WorkUnitModel): void;
  /**
   * The client protocol's roster, from which the SHOWN unit's model is read
   * (#2382 PR C). `summary.model` is the one per-unit model read on both
   * sides; this surface keeps only the catalog, which is leader-global and
   * deliberately not on the protocol.
   *
   * An empty roster means "this caller has none" — the leader-capable float in
   * `wc-tray.ts` follows another leader and has no `RemoteWorkUnitClient` yet
   * — and falls back to the leader's `model.state` frame, which is also the
   * fallback for a leader too old to send `ScoopSummary.model`.
   */
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
  /** Repaint after the shown unit or the roster changed. */
  onShownUnitChanged(): void;
  reset(): void;
} {
  let models: TrayModelCatalogEntry[] = [];
  let state: TrayModelSelectionState | null = null;
  /**
   * The last model this surface could name, PER UNIT. Absent is "not known
   * yet", never "no model" (#2329): a roster can arrive before the unit has
   * one, and reading that as an answer is what latched the pill empty for a
   * whole session. Carried into {@link modelForUnit} as `previous`.
   *
   * Keyed by unit because the carry-forward is only ever about the unit it
   * came from — a single slot would show the PREVIOUS cone's model after a
   * switch to one whose model is momentarily unknown, and would suppress that
   * cone's own `model.state` answer.
   */
  const lastKnownModel = new Map<string, WorkUnitModel>();
  const enabled = opts.modelPickerEnabled !== false;
  const retryDelayMs = opts.catalogRetryDelayMs ?? CATALOG_RETRY_DELAY_MS;
  const retryMaxDelayMs = opts.catalogRetryMaxDelayMs ?? CATALOG_RETRY_MAX_DELAY_MS;
  const retryWindowMs = opts.catalogRetryWindowMs ?? CATALOG_RETRY_WINDOW_MS;
  let retryAttempt = 0;
  /** When the current unresolved stretch stops being worth retrying. */
  let retryDeadline: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The picker is hidden and we cannot tell whether the leader has no models or
   * simply had none yet when we attached. Ask again with backoff for as long as
   * the window allows (#2329) — a leader too old to answer `models.request`
   * just ignores it, and one that really has no models pays a handful of
   * frames spread over a couple of minutes.
   */
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

  /** The pill resolved — stop asking, and re-arm for a future unresolved spell. */
  const clearCatalogRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
    retryDeadline = null;
  };

  /**
   * The provider-qualified id to show: the SHOWN unit's own model, else the
   * leader's `model.state` (an older leader, or a caller with no roster).
   */
  /**
   * Forget units the roster no longer lists. Their carry-forward can never be
   * resolved again, and keeping it would answer for a unit that is gone.
   */
  const pruneForgottenUnits = (units: readonly WorkUnitSummary[]): void => {
    if (units.length === 0) return;
    const live = new Set(units.map((unit) => unit.id));
    for (const jid of lastKnownModel.keys()) if (!live.has(jid)) lastKnownModel.delete(jid);
  };

  /**
   * The provider-qualified id to show for the unit on screen.
   *
   * A `model.state` NAMING that unit is the freshest answer there is, and on
   * this transport it is the ONLY one a pick produces: the leader answers
   * `model.select` with `broadcastModelState()` and pushes no roster (that
   * rides a 5 s interval). Preferring the roster left the pill on the previous
   * model for the rest of the session.
   *
   * The roster answers when there is no frame, or the frame is about a
   * DIFFERENT unit — a tab switch beats the next frame, because the leader
   * answers `scoops.select` with a snapshot and no model state.
   */
  const activeModelId = (): string | undefined => {
    const unitId = opts.getSelectedScoopJid();
    const units = opts.getUnits();
    pruneForgottenUnits(units);
    // Nothing can beat the frame here: this caller has no roster at all (the
    // leader-capable float follows another leader), or does not know yet which
    // unit it is showing.
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
      const model = modelId ? parseQualifiedModelId(modelId) : null;
      if (model && scoopJid) {
        // Seed the pick BEFORE the repaint: the leader's `model.state` for it
        // is a round trip away, and until it lands the roster still names the
        // model this unit is moving off.
        lastKnownModel.set(scoopJid, model);
        opts.setModel(scoopJid, model);
      } else if (modelId) {
        // No unit to name (nothing selected yet), or a bare id carrying no
        // provider: send the raw frame, where the leader resolves the target
        // from this follower's last `scoops.select` and the model id from its
        // own catalog. Naming a unit is what the protocol adds; it cannot
        // invent either half.
        sync.selectModel(modelId, scoopJid ?? undefined);
      }
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
    /**
     * Repaint for a new shown unit. `apply()` otherwise only runs off a
     * catalog or `model.state` frame, and neither is sent on a selection: the
     * leader answers `scoops.select` with a SNAPSHOT, so a tab switch left the
     * pill on the previous cone's model until some unrelated frame arrived.
     * Also the hook for a roster push, which is what carries a model the
     * follower has no `model.state` for.
     */
    onShownUnitChanged() {
      apply();
    },
    reset,
  };
}
