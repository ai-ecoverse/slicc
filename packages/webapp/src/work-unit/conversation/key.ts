import type { RegisteredScoop } from '../../scoops/types.js';
import { workspaceFor } from '../descriptor.js';

const KEY_SEPARATOR = '::';

export function workspaceIdFor(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): string {
  return workspaceFor(scoop).root;
}

export function conversationKeyFor(
  scoop: Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder'>
): string {
  return `${workspaceIdFor(scoop)}${KEY_SEPARATOR}${scoop.jid}`;
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
