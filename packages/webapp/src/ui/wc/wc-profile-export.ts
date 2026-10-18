/**
 * "Export for SLICC 7": the dialog behind Settings → Export for SLICC 7 and
 * the banner, plus the headless run behind the `export-profile` command.
 *
 * The dialog plans first (read, redact, hash; nothing written), shows what
 * will move and what will not — the providers to re-enter (G8) and every
 * credential-like file the zip will hold in the clear (G6) — and writes only
 * once the user confirms.
 */

import type { ProfileFlagRule } from '@slicc/shared-ts';
import type {
  ProfileArchivePlan,
  ProfileExportPlan,
  ProfileExportSummary,
} from '../../transcript/profile-export.js';
import { getProfileExportDeps } from '../../transcript/profile-export-provider.js';

/** Where SLICC 7 lives. */
export const SEVEN_URL = 'https://seven.sliccy.ai';

const STYLE_ID = 'slicc-profile-export-style';

export const PROFILE_FLAG_REASONS: Readonly<Record<ProfileFlagRule, string>> = {
  env: 'environment file, often holds keys',
  pem: 'PEM file, may be a private key',
  'git-credentials': 'git credentials in plain text',
  npmrc: 'npm config, may hold an auth token',
  'slicc-oauth': 'SLICC 6 OAuth state',
};

const SECRET_LABELS: { readonly [kind: string]: string } = {
  'secrets-env': 'secrets.env',
  'chrome-storage': 'extension secrets',
  'github-token': 'the GitHub token',
  'mcp-tokens': 'MCP tokens',
};

export const KEYS_NOTE =
  "Your API keys and logins don't move. You'll enter them again in SLICC 7's Settings.";

const CSS = `
slicc-dialog.wcpx-dialog::part(dialog){width:min(560px,94vw);}
.wcpx{display:flex;flex-direction:column;gap:12px;font-family:var(--ui);color:var(--ink);font-size:13px;line-height:1.45;}
.wcpx__lead{margin:0;color:var(--txt-2);}
.wcpx__summary{font-size:12.5px;color:var(--txt-2);}
.wcpx__box{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--canvas);display:flex;flex-direction:column;gap:6px;}
.wcpx__box--warn{border-color:color-mix(in srgb,#d97706 55%,var(--line));background:color-mix(in srgb,#d97706 9%,var(--canvas));}
.wcpx__title{font-weight:600;font-size:12.5px;}
.wcpx__chips{display:flex;flex-wrap:wrap;gap:6px;}
.wcpx__chip{font:500 11.5px var(--mono,ui-monospace,monospace);padding:2px 8px;border-radius:999px;border:1px solid var(--line);background:var(--ghost);}
.wcpx__files{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto;}
.wcpx__file{display:flex;flex-wrap:wrap;gap:2px 8px;font-size:12px;}
.wcpx__path{font-family:var(--mono,ui-monospace,monospace);word-break:break-all;}
.wcpx__why{color:var(--txt-3);}
.wcpx__muted{font-size:12px;color:var(--txt-3);}
.wcpx__status{font-size:12px;color:var(--txt-3);min-height:16px;}
.wcpx__status[data-error]{color:#b91c1c;}
.wcpx__btn{font:500 12px var(--ui);color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;}
.wcpx__btn:hover{background:var(--ghost);}
.wcpx__btn--primary{background:var(--ink);color:var(--canvas);border-color:var(--ink);}
.wcpx__btn[disabled]{opacity:.5;cursor:default;}
.wcpx a{color:var(--ctx);}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `1.2 MB` style size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line: what the export holds. */
export function describeContents(summary: ProfileExportSummary): string {
  const parts = [
    plural(summary.cones, 'cone'),
    plural(summary.scoops, 'scoop'),
    plural(summary.frozen, 'frozen chat'),
    plural(summary.files, 'file'),
    plural(summary.skills, 'skill'),
    plural(summary.sprinkles, 'sprinkle'),
  ];
  const zips = plural(summary.archives.length, 'zip');
  return `${parts.join(', ')}: ${formatBytes(summary.bytes)} in ${zips}.`;
}

/** What stays behind: mounts, secrets that never move, MCP servers. */
export function describeNotMoved(summary: ProfileExportSummary): string | null {
  const parts: string[] = [];
  if (summary.mounts.length > 0) parts.push(`mounts (${summary.mounts.join(', ')})`);
  if (summary.secrets.length > 0) {
    parts.push(summary.secrets.map((s) => SECRET_LABELS[s] ?? s).join(', '));
  }
  if (summary.mcp.length > 0) {
    parts.push(`MCP connections (${summary.mcp.map((m) => m.name).join(', ')}; add them again)`);
  }
  return parts.length > 0 ? `Not exported: ${parts.join('; ')}.` : null;
}

/** The plain-text report `export-profile` prints. */
export function formatProfileExportReport(
  summary: ProfileExportSummary,
  opts: { dryRun: boolean }
): string {
  const lines: string[] = [];
  const names = summary.archives.join(', ');
  lines.push(
    opts.dryRun
      ? `export-profile: would write ${names} (dry run, nothing saved)`
      : `export-profile: saved ${names} to Downloads`
  );
  lines.push(`  ${describeContents(summary)}`);
  const providers = summary.providers.length > 0 ? summary.providers.join(', ') : 'none';
  lines.push(KEYS_NOTE);
  lines.push(`  Providers to re-enter: ${providers}`);
  if (summary.flagged.length > 0) {
    lines.push(
      `Warning: the zip holds ${plural(summary.flagged.length, 'credential-like file')} in the clear:`
    );
    for (const f of summary.flagged) {
      lines.push(`  ${f.sourcePath} (${formatBytes(f.size)}): ${PROFILE_FLAG_REASONS[f.rule]}`);
    }
  }
  const notMoved = describeNotMoved(summary);
  if (notMoved) lines.push(notMoved);
  lines.push(`Import it in SLICC 7 (${SEVEN_URL}): Freezer → Import from SLICC 6…`);
  return `${lines.join('\n')}\n`;
}

/** Stream one planned archive through the OPFS spool and download it. */
async function saveArchive(archive: ProfileArchivePlan, signal?: AbortSignal): Promise<void> {
  const { transcriptZipToBlob, downloadTranscriptBlob } = await import('./wc-transcript-export.js');
  const stream = archive.open(signal);
  const blob = await transcriptZipToBlob(stream);
  await downloadTranscriptBlob(blob, stream.filename);
}

/** Save every archive of `plan` to Downloads, in order. */
export async function saveProfileArchives(
  plan: ProfileExportPlan,
  opts: {
    signal?: AbortSignal;
    onArchive?: (index: number, archive: ProfileArchivePlan) => void;
  } = {}
): Promise<void> {
  for (let i = 0; i < plan.archives.length; i++) {
    const archive = plan.archives[i]!;
    opts.onArchive?.(i, archive);
    await saveArchive(archive, opts.signal);
  }
}

async function planNow(signal?: AbortSignal): Promise<ProfileExportPlan> {
  const { planProfileExport } = await import('../../transcript/profile-export.js');
  return planProfileExport(getProfileExportDeps(), signal);
}

/** `export-profile` in this page: plan, save unless `dryRun`, report. */
export async function runProfileExportHeadless(opts: {
  dryRun: boolean;
}): Promise<{ report: string; archives: string[] }> {
  const plan = await planNow();
  if (!opts.dryRun) await saveProfileArchives(plan);
  return {
    report: formatProfileExportReport(plan.summary, opts),
    archives: plan.summary.archives,
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) {
    const detail = (err as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail ? `${err.message}: ${detail}` : err.message;
  }
  return String(err);
}

/** Render the planned export's review: keys note, providers, flagged files, leftovers. */
export function renderProfileReview(summary: ProfileExportSummary): HTMLElement {
  const body = el('div', 'wcpx');
  body.append(el('div', 'wcpx__summary', describeContents(summary)));

  const keys = el('div', 'wcpx__box');
  keys.dataset.profileExport = 'keys';
  keys.append(el('div', 'wcpx__title', KEYS_NOTE));
  if (summary.providers.length > 0) {
    keys.append(el('div', 'wcpx__muted', 'Providers to set up again:'));
    const chips = el('div', 'wcpx__chips');
    for (const p of summary.providers) chips.append(el('span', 'wcpx__chip', p));
    keys.append(chips);
  } else {
    keys.append(el('div', 'wcpx__muted', 'No provider accounts are set up here.'));
  }
  body.append(keys);

  if (summary.flagged.length > 0) {
    const warn = el('div', 'wcpx__box wcpx__box--warn');
    warn.dataset.profileExport = 'flagged';
    warn.setAttribute('role', 'alert');
    warn.append(
      el(
        'div',
        'wcpx__title',
        `The zip holds ${plural(summary.flagged.length, 'credential-like file')} in the clear. Anyone with the zip can read them.`
      )
    );
    const list = el('ul', 'wcpx__files');
    for (const f of summary.flagged) {
      const item = el('li', 'wcpx__file');
      item.append(
        el('span', 'wcpx__path', f.sourcePath),
        el('span', 'wcpx__why', `${formatBytes(f.size)}, ${PROFILE_FLAG_REASONS[f.rule]}`)
      );
      list.append(item);
    }
    warn.append(
      list,
      el('div', 'wcpx__muted', "Delete or move them in SLICC 7 if you don't need them there.")
    );
    body.append(warn);
  }

  const notMoved = describeNotMoved(summary);
  if (notMoved) body.append(el('div', 'wcpx__muted', notMoved));
  return body;
}

type DialogEl = HTMLElement & { show?: () => void; hide?: () => void };

/**
 * Open the Export for SLICC 7 dialog. Resolves when it closes. `plan` is
 * injectable for tests and screenshots; it defaults to planning this profile.
 */
export function showProfileExportDialog(
  opts: {
    plan?: (signal: AbortSignal) => Promise<ProfileExportPlan>;
    save?: typeof saveProfileArchives;
  } = {}
): Promise<void> {
  ensureStyle(document);
  const plan = opts.plan ?? planNow;
  const save = opts.save ?? saveProfileArchives;
  const controller = new AbortController();

  const dialog = document.createElement('slicc-dialog') as DialogEl;
  dialog.classList.add('wcpx-dialog');
  dialog.setAttribute('heading', 'Export for SLICC 7');

  const content = el('div', 'wcpx');
  const lead = el('p', 'wcpx__lead');
  lead.append('SLICC 7 is at ');
  const link = document.createElement('a');
  link.href = SEVEN_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'seven.sliccy.ai';
  lead.append(
    link,
    '. This saves your cones, chats, files, memory, skills and licks as a zip you import there.'
  );
  const review = el('div', '');
  const status = el('div', 'wcpx__status', 'Reading your profile…');
  status.setAttribute('aria-live', 'polite');
  content.append(lead, review, status);
  dialog.append(content);

  const cancel = el('button', 'wcpx__btn', 'Cancel');
  cancel.type = 'button';
  cancel.slot = 'footer';
  cancel.dataset.profileExportAction = 'cancel';
  const confirm = el('button', 'wcpx__btn wcpx__btn--primary', 'Export');
  confirm.type = 'button';
  confirm.slot = 'footer';
  confirm.disabled = true;
  confirm.dataset.profileExportAction = 'export';
  dialog.append(cancel, confirm);

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.toggleAttribute('data-error', isError);
  };

  let planned: ProfileExportPlan | null = null;
  let finished = false;
  cancel.addEventListener('click', () => dialog.hide?.());
  confirm.addEventListener('click', () => {
    if (finished) {
      dialog.hide?.();
      return;
    }
    if (!planned) return;
    const current = planned;
    confirm.disabled = true;
    void save(current, {
      signal: controller.signal,
      onArchive: (i, archive) =>
        setStatus(
          current.archives.length > 1
            ? `Saving ${archive.filename} (${i + 1} of ${current.archives.length})…`
            : `Saving ${archive.filename}…`
        ),
    })
      .then(() => {
        finished = true;
        setStatus(
          `Saved to Downloads: ${current.summary.archives.join(', ')}. Open seven.sliccy.ai and import it in the Freezer.`
        );
        confirm.textContent = 'Done';
        confirm.disabled = false;
        cancel.hidden = true;
      })
      .catch((err) => {
        setStatus(`Export failed: ${errorText(err)}`, true);
        confirm.disabled = false;
      });
  });

  return new Promise((resolve) => {
    dialog.addEventListener('slicc-dialog-close', () => {
      controller.abort();
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.show?.();
    plan(controller.signal)
      .then((result) => {
        planned = result;
        review.replaceWith(renderProfileReview(result.summary));
        setStatus('');
        confirm.textContent =
          result.archives.length > 1 ? `Export ${result.archives.length} zips` : 'Export';
        confirm.disabled = false;
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setStatus(`Export failed: ${errorText(err)}`, true);
      });
  });
}
