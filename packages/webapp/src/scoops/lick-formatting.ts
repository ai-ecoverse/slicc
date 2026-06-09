/**
 * Shared formatter for cone-side lick rendering. Used by both `main.ts`
 * (CLI / Electron) and `offscreen.ts` (extension) so both contexts produce
 * identical UX.
 *
 * Returns `null` when the event should be dropped entirely (e.g. an empty
 * `mount-recovery` list).
 */

import type { MountRecoveryEntry } from '../fs/mount-recovery.js';
import { formatMountRecoveryPrompt } from '../fs/mount-recovery.js';
import type { LickEvent } from './lick-manager.js';

export interface FormattedLick {
  label: string;
  content: string;
}

/**
 * Channels emitted by `LickManager.emitEvent` — the "external" lick
 * types as enumerated by `LickEvent['type']`. The Orchestrator uses
 * this set to fire `callbacks.onIncomingMessage` from `handleMessage`
 * so external events render as chat chips live (not just on session
 * reload). The synthetic scoop-lifecycle channels (`scoop-notify`,
 * `scoop-idle`, `scoop-wait`, `scoop-error`, `delegation`) are
 * intentionally excluded — they already have explicit upstream
 * `onIncomingMessage` fires next to the points that build them.
 */
export const EXTERNAL_LICK_CHANNELS: ReadonlySet<LickEvent['type']> = new Set<LickEvent['type']>([
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'upgrade',
  'cherry',
  'workflow',
]);

export function isExternalLickChannel(
  channel: string | null | undefined
): channel is LickEvent['type'] {
  return channel != null && EXTERNAL_LICK_CHANNELS.has(channel as LickEvent['type']);
}

/**
 * Per-channel human-readable label. Identical to the original parallel
 * ternary chain — kept as a lookup so the main formatter stays flat.
 */
const LICK_LABELS: Record<LickEvent['type'], string> = {
  webhook: 'Webhook Event',
  sprinkle: 'Sprinkle Event',
  fswatch: 'File Watch Event',
  'session-reload': 'Session Reload',
  navigate: 'Navigate Event',
  upgrade: 'Upgrade Event',
  cherry: 'Cherry Event',
  workflow: 'Workflow Event',
  cron: 'Cron Event',
};

/**
 * The `eventName` used in the generic-fallback chip. Mirrors the original
 * `eventName` ternary chain exactly (including the unused-but-computed
 * values for channels that take a dedicated branch).
 */
function resolveLickEventName(event: LickEvent): string | undefined {
  switch (event.type) {
    case 'webhook':
      return (event as { webhookName?: string }).webhookName;
    case 'sprinkle':
      return (event as { sprinkleName?: string }).sprinkleName;
    case 'fswatch':
      return (event as { fswatchName?: string }).fswatchName;
    case 'session-reload':
      return 'mount-recovery';
    case 'navigate':
      return (event as { navigateUrl?: string }).navigateUrl;
    case 'upgrade':
      return `${(event as { upgradeFromVersion?: string }).upgradeFromVersion ?? 'unknown'}→${
        (event as { upgradeToVersion?: string }).upgradeToVersion ?? 'unknown'
      }`;
    case 'cherry':
      return (event as { cherryName?: string }).cherryName;
    case 'workflow':
      return (event as { workflowName?: string }).workflowName;
    default:
      return (event as { cronName?: string }).cronName;
  }
}

/**
 * Session-reload formatting. Returns `null` to DROP the lick when the
 * mount-recovery payload is empty; returns `undefined` to signal "no
 * mount-recovery payload — fall through to the generic JSON block".
 */
function formatSessionReloadLick(
  event: LickEvent,
  label: string
): FormattedLick | null | undefined {
  const body = event.body as { reason?: string; mounts?: MountRecoveryEntry[] } | null | undefined;
  if (body?.reason === 'mount-recovery') {
    const prompt = formatMountRecoveryPrompt(body.mounts ?? []);
    if (prompt === null) return null; // empty list — drop the lick
    return { label, content: prompt };
  }
  // session-reload with no mount-recovery payload — fall through to JSON block
  return undefined;
}

function formatUpgradeLick(event: LickEvent, label: string): FormattedLick {
  const from = (event as { upgradeFromVersion?: string }).upgradeFromVersion ?? 'unknown';
  const to = (event as { upgradeToVersion?: string }).upgradeToVersion ?? 'unknown';
  const releasedAt =
    (event.body as { releasedAt?: string | null } | null | undefined)?.releasedAt ?? null;
  const releaseLine = releasedAt ? `\nReleased: ${releasedAt}` : '';
  return {
    label,
    content:
      `[${label}: ${from}→${to}]\n\n` +
      `SLICC was upgraded from \`${from}\` to \`${to}\`.${releaseLine}\n\n` +
      `Use the **upgrade** skill (\`/workspace/skills/upgrade/SKILL.md\`) to:\n` +
      `- Show the user the changelog between these tags from GitHub\n` +
      `- Offer to merge new bundled vfs-root content into their workspace ` +
      `(three-way merge: bundled snapshot vs user's VFS, reconciled with the GitHub tag-to-tag diff).`,
  };
}

function formatCherryLick(event: LickEvent, label: string): FormattedLick {
  const origin = (event as { cherryOrigin?: string }).cherryOrigin ?? 'unknown origin';
  const runtime = (event as { cherryRuntimeId?: string }).cherryRuntimeId ?? 'unknown';
  const name = (event as { cherryName?: string }).cherryName ?? 'unnamed';
  return {
    label,
    content:
      `[${label}: ${name}] from ${origin} (runtime ${runtime})\n` +
      `\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
  };
}

function formatWorkflowLick(event: LickEvent, label: string): FormattedLick {
  const name = event.workflowName ?? 'workflow';
  const path = event.resultPath ?? '(no result file)';
  const preview = event.preview ?? '';
  const status = (event.body as { status?: string } | undefined)?.status ?? 'complete';
  return {
    label,
    content:
      `[${label}: ${name}] ${status} — ${preview}\n` +
      `Full result: ${path} (read it only if you need the whole thing).`,
  };
}

/**
 * Generic fallback chip: webhook / sprinkle / fswatch / navigate / cron
 * (and any channel that fell through its dedicated branch).
 */
function formatGenericLick(event: LickEvent, label: string): FormattedLick {
  const eventName = resolveLickEventName(event);
  const origin = event.originLabel ? `_Forwarded from ${event.originLabel}._\n\n` : '';
  return {
    label,
    content: `${origin}[${label}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
  };
}

/**
 * Build the human-readable label and message body the cone receives for a
 * given lick event. Returns `null` when the event should be silently
 * dropped (empty `mount-recovery` payload).
 */
export function formatLickEventForCone(event: LickEvent): FormattedLick | null {
  const label = LICK_LABELS[event.type];

  if (event.type === 'session-reload') {
    const reload = formatSessionReloadLick(event, label);
    // `null` → drop; a `FormattedLick` → use it; `undefined` → fall through.
    if (reload !== undefined) return reload;
  }
  if (event.type === 'upgrade') return formatUpgradeLick(event, label);
  if (event.type === 'cherry') return formatCherryLick(event, label);
  if (event.type === 'workflow') return formatWorkflowLick(event, label);

  return formatGenericLick(event, label);
}
