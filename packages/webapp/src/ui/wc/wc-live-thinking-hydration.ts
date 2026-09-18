import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import { isRootSummary, modelForUnit } from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { thinkingFor } from '../../work-unit/record.js';
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

export function shouldSkipSessionHydration(
  pendingUrlContext: string | null | undefined,
  win: { location: { href: string }; localStorage: Storage }
): boolean {
  if (rootFolderForContext(pendingUrlContext) === null) return true;
  if (new URL(win.location.href).searchParams.get('cherry') === '1') return true;
  return hasStoredTrayJoinUrl(win.localStorage);
}

export async function applyThreadContext(
  refs: WcShellRefs,
  unit: WorkUnitSummary,
  units: readonly WorkUnitSummary[],

  getRecord?: (id: string) => Pick<RegisteredScoop, 'thinking' | 'config'> | undefined,
  options?: {
    skipModelPill?: boolean;
  }
): Promise<void> {
  const role = unitRoleFor(unit);
  const readOnly = isReadOnlyRole(role);
  refs.thread.setAttribute('context', threadContextFor(unit));
  const isRoot = isRootSummary(unit);
  const accent = scoopColor({ isRoot, name: unit.name });
  refs.thread.setAttribute('accent', accent);
  refs.switcher.setAttribute('active', unit.id);

  applyShellContext(refs, isRoot ? { kind: 'cone' } : { kind: 'scoop', accent });
  applyComposerAvailability(refs, readOnly);
  const lockedEffort = localStorage.getItem('slicc_locked_effort_level');
  const record = getRecord?.(unit.id);

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
  if (options?.skipModelPill) return;
  try {
    const { resolveCurrentModel, resolveModelById } = await import('../provider-settings.js');

    const pinned = modelForUnit(units, unit.id);
    const model = pinned ? resolveModelById(pinned.id, pinned.provider) : resolveCurrentModel();
    refs.composerMeta.setAttribute('model', model.name ?? model.id);
    refs.composerMeta.toggleAttribute(
      'no-thinking',
      (model as { reasoning?: boolean }).reasoning !== true || !!lockedEffort
    );
  } catch {}
}

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

  const [{ CanonicalSessionReader }, { WorkUnitConversationStore }] = await Promise.all([
    import('../../work-unit/conversation/sessions.js'),
    import('../../work-unit/conversation/store.js'),
  ]);
  const session = await new CanonicalSessionReader(
    new WorkUnitConversationStore()
  ).loadRootChatSession(folder);
  if (session && session.messages.length > 0 && !deps.hasSelection()) {
    deps.loadMessages(session.messages);
    deps.onHydrated();
  }
}
