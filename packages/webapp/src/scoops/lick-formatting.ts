/**
 * Shared formatter for cone-side lick rendering. Used by both `main.ts`
 * (CLI / Electron) and `offscreen.ts` (extension) so both contexts produce
 * identical UX.
 *
 * Returns `null` when the event should be dropped entirely (e.g. an empty
 * `mount-recovery` list).
 */

import type { LickEvent } from './lick-manager.js';
import { formatMountRecoveryPrompt } from '../fs/mount-recovery.js';
import type { MountRecoveryEntry } from '../fs/mount-recovery.js';

export interface FormattedLick {
  label: string;
  content: string;
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

  // Generic fallback: webhook / sprinkle / fswatch / navigate / cron.
  return {
    label,
    content: `[${label}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
  };
}
