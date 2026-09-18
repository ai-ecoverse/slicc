import type { RegisteredScoop } from '../../scoops/types.js';
import { workspaceFor } from '../descriptor.js';
import { chatSessionIdFor } from '../record.js';
import type { ConversationIdentity } from './store.js';

const KEY_SEPARATOR = '::';

export function workspaceIdFor(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): string {
  return workspaceFor(scoop).root;
}

export function conversationKeyFor(
  scoop: Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder'>
): string {
  return `${workspaceIdFor(scoop)}${KEY_SEPARATOR}${scoop.jid}`;
}

export function conversationIdentityFor(
  scoop: Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder'>
): ConversationIdentity {
  return {
    key: conversationKeyFor(scoop),
    workUnitId: scoop.jid,
    workspaceId: workspaceIdFor(scoop),
    folder: scoop.folder,
    legacyKeys: { agentSessionId: scoop.jid, chatSessionId: chatSessionIdFor(scoop) },
  };
}

export function parseConversationKey(
  key: string
): { workspaceId: string; workUnitId: string } | null {
  const at = key.lastIndexOf(KEY_SEPARATOR);
  if (at <= 0) return null;
  const workspaceId = key.slice(0, at);
  const workUnitId = key.slice(at + KEY_SEPARATOR.length);
  if (workspaceId.length === 0 || workUnitId.length === 0) return null;
  return { workspaceId, workUnitId };
}
