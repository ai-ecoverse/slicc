/**
 * The session-sharing dialog — "here is the join link, here is what to do
 * with it on each kind of device, and here is who is already attached".
 *
 * Tabs come from `sync-dialog-model.ts` (Status appears the moment a follower
 * connects); follower rows are formatted by `follower-presentation.ts`, the
 * same vocabulary the Monitor panel's Followers section uses. Rendering is
 * split into module-level functions over a shared `SyncDialogCtx` so no single
 * function owns the whole surface.
 */

import { iconEl } from '@slicc/webcomponents/icons';
import type { ConnectedFollowerInfo } from '../shell/supplemental-commands/host-command.js';
import { copyTextToClipboard } from './clipboard.js';
import {
  FOLLOWERS_CHANGED_EVENT,
  followerCapabilities,
  followerDetail,
  followerIcon,
  followerMeta,
  followerStatus,
  followerTitle,
} from './follower-presentation.js';
import {
  buildSyncDialogTabs,
  cliFollowCommand,
  cliInstallCommand,
  cliInstallCommandWindows,
  defaultSyncDialogTab,
  maskJoinUrl,
  revokeConfirmLabel,
  type SyncDialogTabId,
  sharingSummary,
  syncDialogCopy,
} from './sync-dialog-model.js';

export interface SyncEnabledDialogOptions {
  joinUrl: string;
  copied: boolean;
  onReset?: (() => Promise<unknown>) | null;
  /** Current roster; drives the Status tab and the revoke blast-radius copy. */
  followers?: ConnectedFollowerInfo[];
  /** Force a starting tab. Defaults to Status when connected, Browser otherwise. */
  initialTab?: SyncDialogTabId;
}

interface SyncDialogCtx {
  options: SyncEnabledDialogOptions;
  followers: ConnectedFollowerInfo[];
  activeTab: SyncDialogTabId;
  urlRevealed: boolean;
  revokeArmed: boolean;
  overlay: HTMLElement;
  tabsRow: HTMLElement;
  body: HTMLElement;
  statusEl: HTMLElement;
  summaryEl: HTMLElement;
  doneBtn: HTMLButtonElement;
  revokeBtn: HTMLButtonElement | null;
}

const MONO =
  'font-family: var(--s2-font-mono); font-size: 11px; color: var(--s2-content-default); word-break: break-all; padding: 8px 12px; background: var(--s2-bg-sunken); border-radius: var(--s2-radius-default); border: 1px solid var(--s2-border-subtle);';
const MUTED = 'font-size: 11px; color: var(--s2-content-secondary);';
/**
 * `.dialog` only colors `.dialog__title` / `.dialog__desc`, so any element
 * this module builds MUST state its own color — an inherited one resolves to
 * the document default and renders near-black on the dark dialog surface.
 */
const BODY = 'font-size: 12px; color: var(--s2-content-default);';
/** Escapes `.dialog__btn { width: 100% }` for buttons that sit inline in a row. */
const INLINE_BTN = 'flex: 0 0 auto; width: auto; padding: 8px 14px;';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(ctx: SyncDialogCtx, message: string, tone: 'normal' | 'error' = 'normal'): void {
  ctx.statusEl.textContent = message;
  ctx.statusEl.style.color = tone === 'error' ? 'var(--slicc-cone)' : 'var(--s2-content-secondary)';
}

async function copyInto(ctx: SyncDialogCtx, value: string, okMessage: string): Promise<void> {
  const ok = await copyTextToClipboard(value);
  if (ok) setStatus(ctx, okMessage);
  else setStatus(ctx, 'Couldn’t copy. Select the text and copy it manually.', 'error');
}

/**
 * Revoking is two clicks, not a confirm dialog: the first arms the button and
 * rewrites it to name the blast radius ("3 connected devices will be
 * disconnected"), the second performs it.
 */
async function handleRevoke(ctx: SyncDialogCtx): Promise<void> {
  const { onReset } = ctx.options;
  const button = ctx.revokeBtn;
  if (!onReset || !button) return;
  if (!ctx.revokeArmed) {
    ctx.revokeArmed = true;
    button.textContent = revokeConfirmLabel(ctx.followers.length);
    setRevokeArmedStyle(button, true);
    return;
  }
  button.disabled = true;
  ctx.doneBtn.disabled = true;
  setStatus(ctx, 'Revoking the join link…');
  try {
    await onReset();
    setStatus(ctx, 'Join link revoked. Enable sharing from the avatar menu to get a new one.');
    ctx.urlRevealed = false;
    button.textContent = 'Revoked';
    ctx.doneBtn.disabled = false;
    render(ctx);
  } catch (err) {
    setStatus(ctx, `Revoke failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    ctx.revokeArmed = false;
    button.textContent = 'Revoke link';
    setRevokeArmedStyle(button, false);
    button.disabled = false;
    ctx.doneBtn.disabled = false;
  }
}

/**
 * The armed state is the destructive one, so it is the only one that goes
 * red: an idle "Revoke link" is just another secondary button, while
 * "Revoke link? 3 connected devices will be disconnected." is a click away
 * from dropping every follower.
 */
function setRevokeArmedStyle(button: HTMLButtonElement, armed: boolean): void {
  button.dataset.armed = armed ? '1' : '0';
  button.style.background = armed ? 'var(--s2-negative)' : '';
  button.style.borderColor = armed ? 'transparent' : '';
  button.style.color = armed ? '#fff' : '';
}

/** Copy-the-link block shared by the Browser and iPhone tabs. */
function linkBlock(ctx: SyncDialogCtx): HTMLElement {
  const wrap = el('div');
  const copyBtn = el('button', 'margin-bottom: 8px;', 'Copy join link');
  copyBtn.className = 'dialog__btn dialog__btn--secondary';
  copyBtn.dataset.action = 'copy-link';
  copyBtn.addEventListener('click', () => {
    void copyInto(ctx, ctx.options.joinUrl, 'Join link copied.');
  });
  wrap.appendChild(copyBtn);

  const urlRow = el('div', 'display: flex; align-items: center; gap: 8px;');
  const url = el(
    'div',
    `${MONO} flex: 1 1 auto; min-width: 0; color: var(--s2-content-secondary);`
  );
  url.dataset.joinUrl = '1';
  url.textContent = ctx.urlRevealed ? ctx.options.joinUrl : maskJoinUrl(ctx.options.joinUrl);
  // `width: auto` overrides `.dialog__btn { width: 100% }` — without it the
  // button claims the row and squeezes the link into a 6-character column.
  const toggle = el('button', `${INLINE_BTN}`, ctx.urlRevealed ? 'Hide' : 'Show');
  toggle.className = 'dialog__btn dialog__btn--secondary';
  toggle.dataset.action = 'toggle-url';
  toggle.addEventListener('click', () => {
    ctx.urlRevealed = !ctx.urlRevealed;
    render(ctx);
  });
  urlRow.append(url, toggle);
  wrap.appendChild(urlRow);
  wrap.appendChild(
    el('div', `${MUTED} margin-top: 8px;`, 'Anyone with this link can drive this session.')
  );
  return wrap;
}

/**
 * A labelled step: caption, mono command, and its own copy button. `copyValue`
 * defaults to what is shown — the connect step overrides it so the clipboard
 * carries the real token while the display stays masked.
 */
function commandStep(
  ctx: SyncDialogCtx,
  opts: {
    caption: string;
    command: string;
    copyValue?: string;
    action: string;
    copyLabel: string;
    okMessage: string;
  }
): HTMLElement {
  const wrap = el('div', 'margin-bottom: 10px;');
  wrap.appendChild(el('div', `${MUTED} margin-bottom: 4px;`, opts.caption));
  const commandEl = el('div', `${MONO} margin-bottom: 6px;`, opts.command);
  commandEl.dataset.command = opts.action;
  wrap.appendChild(commandEl);
  const copyBtn = el('button', 'margin-bottom: 0;', opts.copyLabel);
  copyBtn.className = 'dialog__btn dialog__btn--secondary';
  copyBtn.dataset.action = opts.action;
  copyBtn.addEventListener('click', () => {
    void copyInto(ctx, opts.copyValue ?? opts.command, opts.okMessage);
  });
  wrap.appendChild(copyBtn);
  return wrap;
}

/**
 * The Terminal tab: install the CLI, then connect with it. Handing over a
 * `slicc …` command without saying where `slicc` comes from was the gap —
 * anyone who doesn't already have the binary hits `command not found`.
 */
function terminalBlock(ctx: SyncDialogCtx, note: string): HTMLElement {
  const wrap = el('div');
  const { joinUrl } = ctx.options;
  const command = cliFollowCommand(joinUrl);
  const shown = ctx.urlRevealed ? command : cliFollowCommand(maskJoinUrl(joinUrl));

  wrap.appendChild(
    commandStep(ctx, {
      caption: '1. Install the slicc CLI (skip if you already have it):',
      command: cliInstallCommand(joinUrl),
      action: 'copy-install',
      copyLabel: 'Copy install command',
      okMessage: 'Install command copied.',
    })
  );
  wrap.appendChild(
    el('div', `${MUTED} margin: -6px 0 12px;`, `Windows: ${cliInstallCommandWindows(joinUrl)}`)
  );

  wrap.appendChild(
    commandStep(ctx, {
      caption: '2. Connect that machine to this session:',
      command: shown,
      copyValue: command,
      action: 'copy-command',
      copyLabel: 'Copy command',
      okMessage: 'Command copied.',
    })
  );

  const toggle = el(
    'button',
    `${INLINE_BTN} margin-bottom: 8px;`,
    ctx.urlRevealed ? 'Hide link' : 'Show link'
  );
  toggle.className = 'dialog__btn dialog__btn--secondary';
  toggle.dataset.action = 'toggle-url';
  toggle.addEventListener('click', () => {
    ctx.urlRevealed = !ctx.urlRevealed;
    render(ctx);
  });
  wrap.appendChild(toggle);

  wrap.appendChild(el('div', `${MUTED} margin-bottom: 0;`, `\u26a0 ${note}`));
  return wrap;
}

function renderHowTo(ctx: SyncDialogCtx, tab: Exclude<SyncDialogTabId, 'status'>): HTMLElement {
  const wrap = el('div');
  const [lead, note] = syncDialogCopy(tab);
  wrap.appendChild(el('div', `${BODY} line-height: 1.5; margin-bottom: 6px;`, lead));
  if (tab === 'terminal') {
    // The terminal note is a warning about what `follow` grants, so it stays
    // next to the command it qualifies.
    wrap.appendChild(terminalBlock(ctx, note));
    return wrap;
  }
  wrap.appendChild(el('div', `${MUTED} margin-bottom: 10px;`, note));
  wrap.appendChild(linkBlock(ctx));
  return wrap;
}

/** One Status-tab row: kind + short id, MOTD, capability chips, live state. */
function followerRow(follower: ConnectedFollowerInfo): HTMLElement {
  const row = el(
    'div',
    'display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: start;'
  );
  row.dataset.follower = follower.runtimeId;

  const icon = el('span', 'display: flex; margin-top: 2px; color: var(--s2-content-secondary);');
  icon.appendChild(iconEl(followerIcon(follower), { size: 14 }));
  row.appendChild(icon);

  const main = el('div', 'display: flex; flex-direction: column; gap: 2px; min-width: 0;');
  main.appendChild(el('div', `${BODY} font-weight: 500;`, followerTitle(follower)));
  const detail = followerDetail(follower);
  if (detail) main.appendChild(el('div', `${MUTED} overflow-wrap: anywhere;`, detail));
  const chips = followerCapabilities(follower);
  if (chips.length > 0) {
    const chipRow = el('div', 'display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px;');
    for (const chip of chips) {
      chipRow.appendChild(
        el(
          'span',
          'padding: 1px 6px; border-radius: 9999px; background: var(--s2-bg-layer-1); border: 1px solid var(--s2-border-subtle); font-size: 10px; font-weight: 600; color: var(--s2-content-secondary);',
          chip
        )
      );
    }
    main.appendChild(chipRow);
  }
  row.appendChild(main);

  const state = followerStatus(follower);
  const dotColor =
    state === 'active'
      ? 'var(--s2-positive)'
      : state === 'warn'
        ? 'var(--s2-notice)'
        : 'var(--s2-content-tertiary)';
  const stateEl = el(
    'div',
    `display: flex; align-items: center; gap: 5px; ${MUTED} white-space: nowrap;`
  );
  stateEl.appendChild(
    el(
      'span',
      `width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: ${dotColor};`
    )
  );
  stateEl.appendChild(el('span', undefined, followerMeta(follower)));
  row.appendChild(stateEl);
  return row;
}

function renderStatusTab(ctx: SyncDialogCtx): HTMLElement {
  const list = el('div', 'display: flex; flex-direction: column; gap: 10px;');
  for (const follower of ctx.followers) list.appendChild(followerRow(follower));
  if (ctx.followers.length === 0) {
    list.appendChild(
      el(
        'div',
        'font-size: 12px; color: var(--s2-content-secondary);',
        'Nothing connected right now.'
      )
    );
  }
  return list;
}

function tabButton(ctx: SyncDialogCtx, id: SyncDialogTabId, label: string): HTMLElement {
  const isActive = id === ctx.activeTab;
  const btn = el(
    'button',
    `flex: 0 0 auto; padding: 4px 10px; border-radius: 9999px; font-size: 12px; cursor: pointer; border: 1px solid ${
      isActive ? 'var(--s2-border-subtle)' : 'transparent'
    }; background: ${isActive ? 'var(--s2-bg-layer-1)' : 'transparent'}; color: ${
      isActive ? 'var(--s2-content-default)' : 'var(--s2-content-secondary)'
    };`,
    label
  );
  btn.type = 'button';
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', String(isActive));
  btn.dataset.tab = id;
  btn.addEventListener('click', () => {
    ctx.activeTab = id;
    render(ctx);
  });
  return btn;
}

function render(ctx: SyncDialogCtx): void {
  const tabs = buildSyncDialogTabs(ctx.followers.length);
  if (!tabs.some((tab) => tab.id === ctx.activeTab)) ctx.activeTab = defaultSyncDialogTab(0);

  ctx.tabsRow.replaceChildren(
    ...tabs.map((tab) =>
      tabButton(ctx, tab.id, tab.badge != null ? `${tab.label} · ${tab.badge}` : tab.label)
    )
  );
  ctx.body.replaceChildren(
    ctx.activeTab === 'status' ? renderStatusTab(ctx) : renderHowTo(ctx, ctx.activeTab)
  );
  ctx.summaryEl.textContent = sharingSummary(ctx.followers.length);
  if (ctx.revokeBtn && !ctx.revokeArmed && ctx.revokeBtn.textContent !== 'Revoked') {
    ctx.revokeBtn.textContent = 'Revoke link';
    setRevokeArmedStyle(ctx.revokeBtn, false);
  }
}

/** Build the dialog chrome; every child is filled in by `render`. */
function buildShell(options: SyncEnabledDialogOptions): SyncDialogCtx {
  const overlay = el('div');
  overlay.className = 'dialog-overlay';
  overlay.dataset.syncDialog = '1';

  const dialog = el('div');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Session sharing');
  overlay.appendChild(dialog);

  const title = el('div', undefined, 'Session sharing');
  title.className = 'dialog__title';

  const tabsRow = el('div', 'display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap;');
  tabsRow.setAttribute('role', 'tablist');

  const body = el('div', 'margin-bottom: 12px;');
  body.setAttribute('role', 'tabpanel');

  const statusEl = el('div', 'font-size: 12px; margin-bottom: 8px; min-height: 16px;');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  const summaryEl = el('div', `${MUTED} margin-bottom: 8px;`);

  const doneBtn = el('button', undefined, 'Done');
  doneBtn.className = 'dialog__btn';

  dialog.append(title, tabsRow, body, statusEl, summaryEl, doneBtn);

  const followers = options.followers ?? [];
  return {
    options,
    followers,
    activeTab: options.initialTab ?? defaultSyncDialogTab(followers.length),
    urlRevealed: false,
    revokeArmed: false,
    overlay,
    tabsRow,
    body,
    statusEl,
    summaryEl,
    doneBtn,
    revokeBtn: null,
  };
}

/**
 * Teardown for the dialog currently on screen, if any. Removing the overlay
 * NODE is not enough: the live instance also holds a `FOLLOWERS_CHANGED_EVENT`
 * window listener and a `keydown` document listener, and both re-open paths
 * (the avatar menu's tray-copy and the floatbar's followers segment) can fire
 * while a dialog is already up. Without this, each re-open leaves the previous
 * instance listening forever and re-rendering into a detached tree.
 */
let closeActiveDialog: (() => void) | null = null;

export function showSyncEnabledDialog(options: SyncEnabledDialogOptions): void {
  closeActiveDialog?.();
  // Belt and braces: an overlay from an instance whose closer was lost (a hot
  // reload, an older build) still gets cleared.
  document.querySelectorAll('.dialog-overlay[data-sync-dialog]').forEach((node) => {
    node.remove();
  });

  const ctx = buildShell(options);
  const dialog = ctx.overlay.firstElementChild as HTMLElement;

  if (options.onReset) {
    const revokeBtn = el('button', 'margin-top: 8px;', 'Revoke link');
    revokeBtn.className = 'dialog__btn dialog__btn--secondary';
    revokeBtn.dataset.action = 'revoke';
    revokeBtn.addEventListener('click', () => {
      void handleRevoke(ctx);
    });
    dialog.appendChild(revokeBtn);
    ctx.revokeBtn = revokeBtn;
  }

  const onFollowersChanged = (event: Event): void => {
    ctx.followers =
      (event as CustomEvent<{ followers?: ConnectedFollowerInfo[] }>).detail?.followers ?? [];
    render(ctx);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  function close(): void {
    window.removeEventListener(FOLLOWERS_CHANGED_EVENT, onFollowersChanged);
    document.removeEventListener('keydown', onKeydown);
    ctx.overlay.remove();
    if (closeActiveDialog === close) closeActiveDialog = null;
  }

  ctx.doneBtn.addEventListener('click', () => close());
  ctx.overlay.addEventListener('click', (event) => {
    if (event.target === ctx.overlay) close();
  });
  window.addEventListener(FOLLOWERS_CHANGED_EVENT, onFollowersChanged);
  document.addEventListener('keydown', onKeydown);

  closeActiveDialog = close;
  if (options.copied) setStatus(ctx, 'Join link copied to clipboard.');
  render(ctx);
  document.body.appendChild(ctx.overlay);
}
