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
  'sudo-request',
  'preview',
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
  'sudo-request': 'Scoop Access Request',
  preview: 'Preview',
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
    case 'sudo-request':
      return (event as { sudoScoopName?: string }).sudoScoopName;
    default:
      return (event as { cronName?: string }).cronName;
  }
}

/**
 * Session-reload formatting. Session-reload licks are agent-actionable: the
 * orchestrator (`registerSessionReloadLick`) mints a `lickId` for every one,
 * so — following the `formatUpgradeLick` / `formatNavigateLick` pattern — the
 * actionable `Lick ID` + guidance is appended only when `event.lickId` is set.
 *
 * - **mount-recovery branch**: confirm + dismiss. `lick_confirm` re-runs the
 *   listed `mount …` commands so the user can re-authorize; `lick_dismiss`
 *   leaves them unmounted. Returns `null` to DROP the lick when the
 *   mount-recovery payload is empty.
 * - **plain reload branch**: dismiss-only. There is NO confirm action — the
 *   card is informational, `lick_dismiss` acknowledges / clears it.
 */
function formatSessionReloadLick(event: LickEvent, label: string): FormattedLick | null {
  const body = event.body as { reason?: string; mounts?: MountRecoveryEntry[] } | null | undefined;
  const lickId = event.lickId;
  if (body?.reason === 'mount-recovery') {
    const prompt = formatMountRecoveryPrompt(body.mounts ?? []);
    if (prompt === null) return null; // empty list — drop the lick
    const guidance = lickId
      ? `\n\nLick ID: ${lickId}\n` +
        `This card is actionable: call \`lick_confirm\` with this lick id to re-run the ` +
        `listed \`mount …\` command(s) so the user can re-authorize, or \`lick_dismiss\` to ` +
        `leave them unmounted. The card flips to ✓ on confirm / muted ✗ on dismiss.`
      : '';
    return { label, content: `${prompt}${guidance}` };
  }
  // session-reload with no mount-recovery payload — generic JSON block, plus a
  // dismiss-only acknowledgement when the orchestrator registered a lick id.
  const generic = formatGenericLick(event, label);
  if (!lickId) return generic;
  const guidance =
    `\n\nLick ID: ${lickId}\n` +
    `This card is informational — there is NO confirm action. Call \`lick_dismiss\` with ` +
    `this lick id to acknowledge and clear it. The card flips to muted ✗ on dismiss.`;
  return { label: generic.label, content: `${generic.content}${guidance}` };
}

/**
 * Upgrade lick. Upgrade licks are agent-actionable with a binary mapping: the
 * cone calls `lick_confirm` to **Update workspace files** (runs the upgrade
 * skill's three-way merge of bundled vfs-root content into the user's VFS) or
 * `lick_dismiss` to clear; the card flips ✓ / muted ✗. Reviewing the changelog
 * is NOT a card action — it stays a separate step the agent can run first. The
 * actionable `Lick ID` + guidance is appended only when the orchestrator
 * registered one (it does for every upgrade lick).
 */
function formatUpgradeLick(event: LickEvent, label: string): FormattedLick {
  const from = (event as { upgradeFromVersion?: string }).upgradeFromVersion ?? 'unknown';
  const to = (event as { upgradeToVersion?: string }).upgradeToVersion ?? 'unknown';
  const releasedAt =
    (event.body as { releasedAt?: string | null } | null | undefined)?.releasedAt ?? null;
  const releaseLine = releasedAt ? `\nReleased: ${releasedAt}` : '';
  const lickId = event.lickId;
  const guidance = lickId
    ? `\n\nLick ID: ${lickId}\n` +
      `Use the **upgrade** skill (\`/workspace/skills/upgrade/SKILL.md\`). The card is a ` +
      `binary action: call \`lick_confirm\` with this lick id to **Update workspace files** ` +
      `(it runs the three-way merge of bundled vfs-root content into the user's VFS), or ` +
      `\`lick_dismiss\` to clear it. The card flips to ✓ on confirm / muted ✗ on dismiss. ` +
      `Reviewing the changelog is a separate step you can run first — it is NOT a card action.`
    : `\n\nUse the **upgrade** skill (\`/workspace/skills/upgrade/SKILL.md\`) to offer the user ` +
      `a three-way merge of bundled vfs-root content into their workspace (bundled snapshot ` +
      `vs user's VFS, reconciled with the GitHub tag-to-tag diff).`;
  return {
    label,
    content:
      `[${label}: ${from}→${to}]\n\n` +
      `SLICC was upgraded from \`${from}\` to \`${to}\`.${releaseLine}${guidance}`,
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

function formatPreviewLick(event: LickEvent, label: string): FormattedLick {
  const origin = (event as { previewOrigin?: string }).previewOrigin ?? 'unknown origin';
  const lifecycle = (event as { previewLifecycle?: string }).previewLifecycle ?? 'unknown';
  const verb = lifecycle === 'connected' ? 'connected' : 'disconnected';
  return {
    label,
    content: `Preview tab ${verb} from ${origin}`,
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
 * Sudo-request body mirrors `formatSudoRequestNotification` in orchestrator.ts
 * so the cone-readable text restates the lick id + kind + detail + suggested
 * pattern and points at the `lick_confirm` tool. Used by the UI chip path; the
 * actionable agent message is delivered separately via
 * `deliverSudoRequestToCone` (Path b in the lick-as-UI-chip design — see
 * `Orchestrator.enqueueSudoRequest` and `defaultLickEventHandler`).
 */
function formatSudoRequestLick(event: LickEvent, label: string): FormattedLick {
  const scoop = event.sudoScoopName ?? 'a scoop';
  const lickId = event.lickId ?? '(unknown)';
  const kind = event.sudoKind ?? 'unknown';
  const detail = event.sudoDetail ?? '';
  const lines = [
    `[${label}: ${scoop}]`,
    `Lick ID: ${lickId}`,
    `Kind: ${kind}`,
    `Detail: ${detail}`,
  ];
  if (event.sudoSuggestedPattern) {
    lines.push(`Suggested pattern: ${event.sudoSuggestedPattern}`);
  }
  lines.push(
    '',
    `Use the lick_confirm tool with lick_id="${lickId}" to approve (or always-approve with a pattern), or lick_dismiss with lick_id="${lickId}" to deny.`
  );
  return { label, content: lines.join('\n') };
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
 * Webhook lick. A driveable-preview `window.slicc.emit()` routed over the
 * bridge WS arrives as a webhook event carrying `x-slicc-preview-conn` /
 * `x-slicc-preview-token` headers (stamped server-side by the tray DO from the
 * originating socket). When present, render it as an attributed **Preview
 * Event** — distinguishable from a plain webhook and tied to the exact tab
 * (`preview:<token>:<conn>`, the same id you'd drive). Plain webhooks (and the
 * unattributed page-unload beacon fallback) fall through to the generic chip.
 */
function formatWebhookLick(event: LickEvent, label: string): FormattedLick {
  const headers = (event as { headers?: Record<string, string> }).headers;
  const conn = headers?.['x-slicc-preview-conn'];
  if (!conn) return formatGenericLick(event, label);
  const token = headers['x-slicc-preview-token'] ?? '';
  const name = (event.body as { name?: string } | null | undefined)?.name ?? 'event';
  const target = token ? ` (preview:${token}:${conn})` : ` (conn ${conn})`;
  return {
    label: 'Preview Event',
    content: `[Preview event: ${name}] from tab${target}\n\`\`\`json\n${JSON.stringify(
      event.body,
      null,
      2
    )}\n\`\`\``,
  };
}

/**
 * Navigate (handoff / upskill) lick. Keeps the generic `[Navigate Event: url]`
 * + JSON-body block the handoff skill parses, then appends the actionable
 * `Lick ID` and verb-specific guidance when the orchestrator registered one:
 *
 * - **upskill** is agent-actionable — the cone installs via `lick_confirm`
 *   (runs `upskill`, honoring any `branch` / `path` scope) or skips via
 *   `lick_dismiss`; the card flips ✓ / muted ✗.
 * - **handoff** stays human-gated — the cone shows the approval dip and must
 *   NOT self-approve; carrying the lick id in the dip action flips the card
 *   when the human accepts / dismisses.
 */
function formatNavigateLick(event: LickEvent, label: string): FormattedLick {
  const generic = formatGenericLick(event, label);
  const lickId = event.lickId;
  if (!lickId) return generic;
  const verb = (event.body as { verb?: string } | null | undefined)?.verb;
  const guidance =
    verb === 'upskill'
      ? `\n\nLick ID: ${lickId}\n` +
        `Upskill install. To install, call \`lick_confirm\` with this lick id ` +
        `(it runs \`upskill\` with any branch/path scope from the body); to skip, call ` +
        `\`lick_dismiss\`. The card flips to ✓ on confirm / muted ✗ on dismiss.`
      : `\n\nLick ID: ${lickId}\n` +
        `External handoff — stays human-gated. Show the approval dip and wait for the user; ` +
        `do NOT use \`lick_confirm\` / \`lick_dismiss\` here. Carry the lick id in the dip ` +
        `action so the card resolves: ` +
        `slicc.lick({action:'accept'|'dismiss', data:{lickId:'${lickId}'}}).`;
  return { label: generic.label, content: `${generic.content}${guidance}` };
}

/**
 * Build the human-readable label and message body the cone receives for a
 * given lick event. Returns `null` when the event should be silently
 * dropped (empty `mount-recovery` payload).
 */
export function formatLickEventForCone(event: LickEvent): FormattedLick | null {
  const label = LICK_LABELS[event.type];

  if (event.type === 'session-reload') return formatSessionReloadLick(event, label);
  if (event.type === 'upgrade') return formatUpgradeLick(event, label);
  if (event.type === 'cherry') return formatCherryLick(event, label);
  if (event.type === 'preview') return formatPreviewLick(event, label);
  if (event.type === 'workflow') return formatWorkflowLick(event, label);
  if (event.type === 'sudo-request') return formatSudoRequestLick(event, label);
  if (event.type === 'navigate') return formatNavigateLick(event, label);
  if (event.type === 'webhook') return formatWebhookLick(event, label);

  return formatGenericLick(event, label);
}
