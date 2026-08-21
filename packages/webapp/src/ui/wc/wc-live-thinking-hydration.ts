import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { notifyLeaderLocalModelStateChanged } from './leader-model-events.js';
import { metaThinkingForScoop } from './wc-follower-model-surface.js';
import { scoopColor } from './wc-scoop-color.js';
import { applyShellContext, type WcShellRefs } from './wc-shell.js';
import { threadContextFor } from './wc-unit-context.js';

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

/** Whether leader-owned state will replace local cone history during boot. */
export function shouldSkipSessionHydration(
  pendingUrlContext: string | null | undefined,
  win: { location: { href: string }; localStorage: Storage }
): boolean {
  if (pendingUrlContext != null && pendingUrlContext !== 'cone') return true;
  if (new URL(win.location.href).searchParams.get('cherry') === '1') return true;
  return hasStoredTrayJoinUrl(win.localStorage);
}

/** Point the thread chrome at a scoop (context label + accent hue + model). */
export async function applyThreadContext(refs: WcShellRefs, scoop: RegisteredScoop): Promise<void> {
  refs.thread.setAttribute('context', threadContextFor(scoop));
  refs.thread.setAttribute('accent', scoopColor(scoop));
  refs.switcher.setAttribute('active', scoop.jid);
  applyShellContext(
    refs,
    scoop.isCone ? { kind: 'cone' } : { kind: 'scoop', accent: scoopColor(scoop) }
  );
  const lockedEffort = localStorage.getItem('slicc_locked_effort_level');
  refs.composerMeta.setAttribute(
    'thinking',
    metaThinkingForScoop(
      (lockedEffort ?? scoop.config?.thinkingLevel) as ThinkingLevel | undefined,
      scoop.config?.effortOverride
    )
  );
  try {
    const { resolveCurrentModel, resolveModelById } = await import('../provider-settings.js');
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    refs.composerMeta.setAttribute('model', model.name ?? model.id);
    refs.composerMeta.toggleAttribute(
      'no-thinking',
      (model as { reasoning?: boolean }).reasoning !== true || !!lockedEffort
    );
  } catch {
    // Model display is informational; never block scoop selection on it.
  }
}

/** Hydrate persisted cone history until the worker's canonical replay arrives. */
export async function hydratePersistedConeSession(deps: {
  pendingUrlContext: string | null | undefined;
  win: { location: { href: string }; localStorage: Storage };
  hasSelection(): boolean;
  loadMessages(messages: import('../types.js').ChatMessage[]): void;
  onHydrated(): void;
}): Promise<void> {
  if (shouldSkipSessionHydration(deps.pendingUrlContext, deps.win)) return;
  const { SessionStore } = await import('../../scoops/chat-session-store.js');
  const store = new SessionStore();
  await store.init();
  const session = await store.load('session-cone');
  if (session && session.messages.length > 0 && !deps.hasSelection()) {
    deps.loadMessages(session.messages);
    deps.onHydrated();
  }
}
