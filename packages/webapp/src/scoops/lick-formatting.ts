import type { MountRecoveryEntry } from '../fs/mount-recovery.js';
import { formatMountRecoveryPrompt } from '../fs/mount-recovery.js';
import type { LickEvent } from './lick-manager.js';

export interface FormattedLick {
  label: string;
  content: string;
}

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
  'bash',
  'jshd',
  'sudo-request',
  'preview',
  'discovery',
]);

export function isExternalLickChannel(
  channel: string | null | undefined
): channel is LickEvent['type'] {
  return channel != null && EXTERNAL_LICK_CHANNELS.has(channel as LickEvent['type']);
}

const LICK_LABELS: Record<LickEvent['type'], string> = {
  webhook: 'Webhook Event',
  sprinkle: 'Sprinkle Event',
  fswatch: 'File Watch Event',
  'session-reload': 'Session Reload',
  navigate: 'Navigate Event',
  upgrade: 'Upgrade Event',
  cherry: 'Cherry Event',
  workflow: 'Workflow Event',
  bash: 'Background Command',
  jshd: 'jshd Unit',
  cron: 'Cron Event',
  'sudo-request': 'Scoop Access Request',
  preview: 'Preview',
  discovery: 'Discovery Event',
};

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
    case 'bash':
      return (event as { bashJobId?: string }).bashJobId;
    case 'jshd':
      return (event as { jshdName?: string }).jshdName;
    case 'sudo-request':
      return (event as { sudoScoopName?: string }).sudoScoopName;
    case 'discovery':
      return (
        (event as { discoveryUrl?: string }).discoveryUrl ??
        (event as { discoveryOrigin?: string }).discoveryOrigin
      );
    default:
      return (event as { cronName?: string }).cronName;
  }
}

function formatSessionReloadLick(event: LickEvent, label: string): FormattedLick | null {
  const body = event.body as { reason?: string; mounts?: MountRecoveryEntry[] } | null | undefined;
  const lickId = event.lickId;
  if (body?.reason === 'mount-recovery') {
    const prompt = formatMountRecoveryPrompt(body.mounts ?? []);
    if (prompt === null) return null;
    const guidance = lickId
      ? `\n\nLick ID: ${lickId}\n` +
        `This card is actionable: call \`lick_confirm\` with this lick id to re-run the ` +
        `listed \`mount …\` command(s) so the user can re-authorize, or \`lick_dismiss\` to ` +
        `leave them unmounted. The card flips to ✓ on confirm / muted ✗ on dismiss.`
      : '';
    return { label, content: `${prompt}${guidance}` };
  }

  const generic = formatGenericLick(event, label);
  if (!lickId) return generic;
  const guidance =
    `\n\nLick ID: ${lickId}\n` +
    `This card is informational — there is NO confirm action. Call \`lick_dismiss\` with ` +
    `this lick id to acknowledge and clear it. The card flips to muted ✗ on dismiss.`;
  return { label: generic.label, content: `${generic.content}${guidance}` };
}

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

function formatJshdLick(event: LickEvent, label: string): FormattedLick {
  const name = event.jshdName ?? 'unknown';
  const restarts = event.jshdRestarts ?? 0;
  const path = event.resultPath;
  const tail = path
    ? `Logs: ${path} (page with \`jshd logs ${name}\`).`
    : 'No log file was written.';
  const preview = event.preview?.length ? `\n\n\`\`\`\n${event.preview}\n\`\`\`` : '';
  return {
    label,
    content:
      `[${label}: ${name}] marked errored after ${restarts} restarts.\n` +
      `The restart policy stopped trying so the unit does not crash-loop.\n` +
      `${tail}${preview}\n\n` +
      `Inspect with \`jshd status ${name}\`; start it again with \`jshd start -n ${name}\` after fixing the script.`,
  };
}

function formatBashLick(event: LickEvent, label: string): FormattedLick {
  const jobId = event.bashJobId ?? 'unknown job';
  const pid = event.bashJobPid === undefined ? '' : ` (pid ${event.bashJobPid})`;
  const command = event.bashCommand ?? '(unknown command)';
  const exitCode = event.bashExitCode;

  const verdict =
    exitCode === 0
      ? 'succeeded'
      : exitCode === 130 || exitCode === 137 || exitCode === 143
        ? `was terminated (exit code ${exitCode}) — killed by a signal, not by its own failure`
        : `failed (exit code ${exitCode ?? 'unknown'})`;
  const path = event.resultPath;
  const tail = path
    ? `Full output: ${path} (page it with \`sed -n\`/\`tail\`/\`grep\` if the preview below is cut).`
    : 'Its output could NOT be written to a file — the preview below is all that survived.';
  const preview = event.preview?.length ? `\n\n\`\`\`\n${event.preview}\n\`\`\`` : '';
  return {
    label,
    content:
      `[${label}: ${jobId}${pid}] \`${command}\` ${verdict}.\n` +
      `${tail}${preview}\n\n` +
      'This is the delayed result of a command that was detached earlier in this session — ' +
      'do not re-run it. Act on it if it still matters, otherwise acknowledge and move on.',
  };
}

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
  if (event.sudoReason) lines.push(`Reason given: ${event.sudoReason}`);
  if (event.sudoSuggestedPattern) {
    lines.push(`Suggested pattern: ${event.sudoSuggestedPattern}`);
  }
  lines.push(
    '',
    `Use the lick_confirm tool with lick_id="${lickId}" to approve (or always-approve with a pattern), or lick_dismiss with lick_id="${lickId}" and a reason to deny.`
  );
  return { label, content: lines.join('\n') };
}

function formatDiscoveryLick(event: LickEvent, label: string): FormattedLick {
  const origin = event.discoveryOrigin ?? 'an origin';
  const url = event.discoveryUrl ?? '(unknown URL)';
  const artifact =
    event.discoveryKind === 'llms-txt' ? 'an llms.txt digest' : 'an ai-catalog manifest';
  const kind = event.discoveryKind ?? 'unknown';
  const origPrefix = event.originLabel ? `_Forwarded from ${event.originLabel}._\n\n` : '';
  const guidance =
    event.discoveryKind === 'llms-txt' && event.lickId
      ? `\n\nLick ID: ${event.lickId}\n` +
        `This card is dismiss-only: call \`lick_dismiss\` to add the advertising host to ` +
        `\`/etc/llmstxtignore\` and silence future discoveries without a prompt. ` +
        `There is NO confirm action.`
      : `\nThis is informational — there is no card action.`;
  return {
    label,
    content:
      `${origPrefix}[${label}: ${url}]\n` +
      `${origin} advertises ${artifact} (kind: ${kind}) at ${url}.` +
      `${guidance}\nYou MAY fetch it (e.g. \`curl ${url}\`) when relevant.`,
  };
}

function formatGenericLick(event: LickEvent, label: string): FormattedLick {
  const eventName = resolveLickEventName(event);
  const origin = event.originLabel ? `_Forwarded from ${event.originLabel}._\n\n` : '';
  return {
    label,
    content: `${origin}[${label}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
  };
}

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

function formatNavigateLick(event: LickEvent, label: string): FormattedLick {
  const generic = formatGenericLick(event, label);
  const lickId = event.lickId;
  if (!lickId) return generic;
  const verb = (event.body as { verb?: string } | null | undefined)?.verb;
  const guidance =
    verb === 'upskill'
      ? `\n\nLick ID: ${lickId}\n` +
        `Upskill install. To install, call \`lick_confirm\` with this lick id ` +
        `(it runs \`upskill … --all\` with any branch/path scope from the body, so it ` +
        `installs EVERY skill under that scope — a broad path can be many); to skip, call ` +
        `\`lick_dismiss\`. The card flips to ✓ on confirm / muted ✗ on dismiss.`
      : `\n\nLick ID: ${lickId}\n` +
        `External handoff — stays human-gated. Show the approval dip and wait for the user; ` +
        `do NOT use \`lick_confirm\` / \`lick_dismiss\` here. Carry the lick id in the dip ` +
        `action so the card resolves: ` +
        `slicc.lick({action:'accept'|'dismiss', data:{lickId:'${lickId}'}}).`;
  return { label: generic.label, content: `${generic.content}${guidance}` };
}

export function formatLickEventForCone(event: LickEvent): FormattedLick | null {
  const label = LICK_LABELS[event.type];

  if (event.type === 'session-reload') return formatSessionReloadLick(event, label);
  if (event.type === 'upgrade') return formatUpgradeLick(event, label);
  if (event.type === 'cherry') return formatCherryLick(event, label);
  if (event.type === 'preview') return formatPreviewLick(event, label);
  if (event.type === 'workflow') return formatWorkflowLick(event, label);
  if (event.type === 'bash') return formatBashLick(event, label);
  if (event.type === 'jshd') return formatJshdLick(event, label);
  if (event.type === 'sudo-request') return formatSudoRequestLick(event, label);
  if (event.type === 'navigate') return formatNavigateLick(event, label);
  if (event.type === 'webhook') return formatWebhookLick(event, label);
  if (event.type === 'discovery') return formatDiscoveryLick(event, label);

  return formatGenericLick(event, label);
}
