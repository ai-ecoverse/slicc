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
 * Build the human-readable label and message body the cone receives for a
 * given lick event. Returns `null` when the event should be silently
 * dropped (empty `mount-recovery` payload).
 */
export function formatLickEventForCone(event: LickEvent): FormattedLick | null {
  const isWebhook = event.type === 'webhook';
  const isSprinkle = event.type === 'sprinkle';
  const isFsWatch = event.type === 'fswatch';
  const isSessionReload = event.type === 'session-reload';
  const isNavigate = event.type === 'navigate';
  const isUpgrade = event.type === 'upgrade';
  const isCherry = event.type === 'cherry';
  const isWorkflow = event.type === 'workflow';

  const eventName = isWebhook
    ? (event as { webhookName?: string }).webhookName
    : isSprinkle
      ? (event as { sprinkleName?: string }).sprinkleName
      : isFsWatch
        ? (event as { fswatchName?: string }).fswatchName
        : isSessionReload
          ? 'mount-recovery'
          : isNavigate
            ? (event as { navigateUrl?: string }).navigateUrl
            : isUpgrade
              ? `${(event as { upgradeFromVersion?: string }).upgradeFromVersion ?? 'unknown'}→${
                  (event as { upgradeToVersion?: string }).upgradeToVersion ?? 'unknown'
                }`
              : isCherry
                ? (event as { cherryName?: string }).cherryName
                : isWorkflow
                  ? (event as { workflowName?: string }).workflowName
                  : (event as { cronName?: string }).cronName;

  const label = isWebhook
    ? 'Webhook Event'
    : isSprinkle
      ? 'Sprinkle Event'
      : isFsWatch
        ? 'File Watch Event'
        : isSessionReload
          ? 'Session Reload'
          : isNavigate
            ? 'Navigate Event'
            : isUpgrade
              ? 'Upgrade Event'
              : isCherry
                ? 'Cherry Event'
                : isWorkflow
                  ? 'Workflow Event'
                  : 'Cron Event';

  if (isSessionReload) {
    const body = event.body as
      | { reason?: string; mounts?: MountRecoveryEntry[] }
      | null
      | undefined;
    if (body?.reason === 'mount-recovery') {
      const prompt = formatMountRecoveryPrompt(body.mounts ?? []);
      if (prompt === null) return null; // empty list — drop the lick
      return { label, content: prompt };
    }
    // session-reload with no mount-recovery payload — fall through to JSON block
  }

  if (isUpgrade) {
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

  if (isCherry) {
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

  if (isWorkflow) {
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

  // Generic fallback: webhook / sprinkle / fswatch / navigate / cron.
  const origin = event.originLabel ? `_Forwarded from ${event.originLabel}._\n\n` : '';
  return {
    label,
    content: `${origin}[${label}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
  };
}
