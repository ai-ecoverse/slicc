import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import { chatSessionIdFor, modelFor, thinkingFor } from '../../work-unit/record.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { notifyLeaderLocalModelStateChanged } from './leader-model-events.js';
import { metaThinkingForScoop } from './wc-follower-model-surface.js';
import { scoopColor } from './wc-scoop-color.js';
import { applyShellContext, type WcShellRefs } from './wc-shell.js';
import { rootFolderForContext, rootForSelection, threadContextFor } from './wc-unit-context.js';

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
 * `roster` lets the model pill follow the unit the PICKER edits: a selected
 * scoop shows the model of the cone that owns it (#2310), because a pick made
 * while a scoop is selected lands on that cone and scoops are never
 * retargeted. Thinking stays per selected unit. Without a roster (older
 * callers) the selected unit answers for itself.
 */
export async function applyThreadContext(
  refs: WcShellRefs,
  scoop: RegisteredScoop,
  roster: readonly RegisteredScoop[] = []
): Promise<void> {
  refs.thread.setAttribute('context', threadContextFor(scoop));
  refs.thread.setAttribute('accent', scoopColor(scoop));
  refs.switcher.setAttribute('active', scoop.jid);
  applyShellContext(
    refs,
    scoop.isCone ? { kind: 'cone' } : { kind: 'scoop', accent: scoopColor(scoop) }
  );
  const lockedEffort = localStorage.getItem('slicc_locked_effort_level');
  const thinking = thinkingFor(scoop);
  refs.composerMeta.setAttribute(
    'thinking',
    metaThinkingForScoop(
      (lockedEffort ?? thinking.level) as ThinkingLevel | undefined,
      thinking.effortOverride
    )
  );
  try {
    const { resolveCurrentModel, resolveModelById } = await import('../provider-settings.js');
    // The pill follows the model of the cone the picker writes to (#2310) —
    // switching cones switches the model shown.
    const pinned = modelFor(rootForSelection(roster, scoop) ?? scoop);
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
