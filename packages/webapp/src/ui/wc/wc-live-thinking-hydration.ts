import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import { isRootSummary, modelForUnit } from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { chatSessionIdFor, thinkingFor } from '../../work-unit/record.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { notifyLeaderLocalModelStateChanged } from './leader-model-events.js';
import { metaThinkingForScoop } from './wc-follower-model-surface.js';
import { scoopColor } from './wc-scoop-color.js';
import { applyComposerAvailability, applyShellContext, type WcShellRefs } from './wc-shell.js';
import {
  isReadOnlyRole,
  rootFolderForContext,
  threadContextFor,
  unitRoleFor,
} from './wc-unit-context.js';

export {
  effortOverrideForAgent,
  metaThinkingForScoop,
  thinkingLevelForAgent,
} from './wc-follower-model-surface.js';

/** Persist a leader-local thinking change and notify followers only after its ack. */
export async function applyLeaderLocalThinkingChange(
  client: Pick<OffscreenClient, 'setScoopThinkingLevel'>,
  scoopJid: string,
  level: ThinkingLevel | undefined,
  effortOverride?: string,
  notify: () => void = notifyLeaderLocalModelStateChanged
): Promise<boolean> {
  const applied = await client.setScoopThinkingLevel(scoopJid, level, effortOverride);
  if (applied) notify();
  return applied;
}

/**
 * Whether leader-owned state will replace local cone history during boot.
 * A `cone:<folder>` deep link is NOT a skip — it hydrates that cone's own
 * persisted history (#2272); only non-cone contexts (`scoop:`, `freezer:`)
 * and leader-owned floats (Cherry, a joined tray) are.
 */
export function shouldSkipSessionHydration(
  pendingUrlContext: string | null | undefined,
  win: { location: { href: string }; localStorage: Storage }
): boolean {
  if (rootFolderForContext(pendingUrlContext) === null) return true;
  if (new URL(win.location.href).searchParams.get('cherry') === '1') return true;
  return hasStoredTrayJoinUrl(win.localStorage);
}

/**
 * Point the thread chrome at a scoop (context label + accent hue + model).
 *
 * A scoop is a READ-ONLY transcript (#2312): the whole composer band is
 * hidden, so its model and thinking pills are not shown. They are still kept
 * CORRECT rather than skipped — the band is hidden, not torn down, and
 * leaving a stale pill inside it would surface the moment any future path
 * shows the band without a fresh `applyThreadContext`.
 *
 * `units` lets the model pill follow the unit the PICKER edits (#2310): a
 * pick made while a scoop is selected lands on the cone that owns it, and
 * scoops are never retargeted. Thinking stays per selected unit; a unit whose
 * owning cone is not in the roster answers for itself.
 *
 * The roster arrives as the client protocol's SUMMARIES rather than as
 * records, because `summary.model` is the one per-unit model read on both
 * sides now (#2382 PR C). It is required for that reason: an empty roster
 * used to mean "read the record instead", and there is no record to read
 * here — it would silently mean "this unit has no model".
 */
export async function applyThreadContext(
  refs: WcShellRefs,
  unit: WorkUnitSummary,
  units: readonly WorkUnitSummary[],
  /**
   * The unit's RECORD, for the one field the summary does not carry: the
   * reasoning level. Read at the leaf (#2382 D2a) rather than by widening the
   * selection back to a record, so this stays callable with a follower's
   * summary — which simply has no record and no thinking pill.
   */
  getRecord?: (id: string) => Pick<RegisteredScoop, 'thinking' | 'config'> | undefined
): Promise<void> {
  const role = unitRoleFor(unit);
  const readOnly = isReadOnlyRole(role);
  refs.thread.setAttribute('context', threadContextFor(unit));
  const isRoot = isRootSummary(unit);
  const accent = scoopColor({ isRoot, name: unit.name });
  refs.thread.setAttribute('accent', accent);
  refs.switcher.setAttribute('active', unit.id);
  // The 'scoop' shell mood (shader + accent) is unchanged — only the
  // interactive chrome goes away.
  applyShellContext(refs, isRoot ? { kind: 'cone' } : { kind: 'scoop', accent });
  applyComposerAvailability(refs, readOnly);
  const lockedEffort = localStorage.getItem('slicc_locked_effort_level');
  const record = getRecord?.(unit.id);
  // Absent is "not known yet", never "off" — the same rule the model pill
  // follows (#2329). `metaThinkingForScoop` answers `off` for an unknown
  // level, which for a caller that carries no records (a follower, #2382
  // D2b) would report reasoning as DISABLED on every selection. With nothing
  // to say the pill keeps the value it had. A locked effort level is an
  // answer in its own right and is written whether or not a record answered.
  if (record || lockedEffort) {
    const thinking = record ? thinkingFor(record) : {};
    refs.composerMeta.setAttribute(
      'thinking',
      metaThinkingForScoop(
        (lockedEffort ?? thinking.level) as ThinkingLevel | undefined,
        thinking.effortOverride
      )
    );
  }
  try {
    const { resolveCurrentModel, resolveModelById } = await import('../provider-settings.js');
    // The pill follows the model of the cone the picker writes to (#2310) —
    // switching cones switches the model shown. Absent is "not known yet",
    // so the profile default answers rather than the pill going blank (#2329).
    const pinned = modelForUnit(units, unit.id);
    const model = pinned ? resolveModelById(pinned.id, pinned.provider) : resolveCurrentModel();
    refs.composerMeta.setAttribute('model', model.name ?? model.id);
    refs.composerMeta.toggleAttribute(
      'no-thinking',
      (model as { reasoning?: boolean }).reasoning !== true || !!lockedEffort
    );
  } catch {
    // Model display is informational; never block scoop selection on it.
  }
}

/**
 * Hydrate persisted cone history until the worker's canonical replay
 * arrives. The cone is the one the URL context addresses — `?ctx=cone:work`
 * hydrates `session-cone-work`, a bare boot the primary `session-cone`.
 */
export async function hydratePersistedConeSession(deps: {
  pendingUrlContext: string | null | undefined;
  win: { location: { href: string }; localStorage: Storage };
  hasSelection(): boolean;
  loadMessages(messages: import('../types.js').ChatMessage[]): void;
  onHydrated(): void;
}): Promise<void> {
  if (shouldSkipSessionHydration(deps.pendingUrlContext, deps.win)) return;
  const folder = rootFolderForContext(deps.pendingUrlContext);
  if (folder === null) return;
  const { SessionStore } = await import('../../scoops/chat-session-store.js');
  const store = new SessionStore();
  await store.init();
  const session = await store.load(chatSessionIdFor({ folder }));
  if (session && session.messages.length > 0 && !deps.hasSelection()) {
    deps.loadMessages(session.messages);
    deps.onHydrated();
  }
}
