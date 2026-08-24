/**
 * Identity of a canonical conversation record (#2275): work unit ×
 * workspace.
 *
 * The unit alone is not enough. A record has to survive a profile whose
 * filesystem view moved (per-cone workspaces, #2271) without silently
 * adopting another unit's history, and the two legacy stores disagree about
 * what identifies a conversation in exactly that dimension — `agent-sessions`
 * keys by jid, `browser-coding-agent` by `session-<folder>`. Naming both
 * halves makes the key say which conversation it is AND which filesystem it
 * belongs to.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import { workspaceFor } from '../descriptor.js';

/** Separator that cannot appear in a jid or an absolute path. */
const KEY_SEPARATOR = '::';

/**
 * Identity of a unit's filesystem view: its workspace root (`/workspace`,
 * `/cones/<folder>/workspace`, `/scoops/<folder>/workspace`). Derived, never
 * stored on the record — `workspaceFor` stays the single place the layout is
 * decided (#2271).
 */
export function workspaceIdFor(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): string {
  return workspaceFor(scoop).root;
}

/** The canonical store key of a unit's conversation. */
export function conversationKeyFor(
  scoop: Pick<RegisteredScoop, 'jid' | 'parentJid' | 'folder'>
): string {
  return `${workspaceIdFor(scoop)}${KEY_SEPARATOR}${scoop.jid}`;
}

/** Split a key back into its halves; `null` when it is not one of ours. */
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
