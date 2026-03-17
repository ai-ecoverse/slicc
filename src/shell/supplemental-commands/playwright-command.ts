/**
 * playwright-cli — Playwright-compatible CLI for browser automation.
 *
 * Registered as `playwright-cli`, `playwright`, and `puppeteer`.
 * Uses BrowserAPI + VirtualFS injected from the shell options.
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { BrowserAPI, PageInfo } from '../../cdp/index.js';
import { HarRecorder } from '../../cdp/index.js';
import { normalizeAccessibilityText } from '../../cdp/normalize-accessibility-text.js';
import type { AccessibilityNode } from '../../cdp/types.js';
import { FsError, type VirtualFS } from '../../fs/index.js';

/** Per-tab snapshot: accessibility tree with element refs. */
interface TabSnapshot {
  url: string;
  title: string;
  refToSelector: Map<string, string>;
  refToBackendNodeId: Map<string, number>;
  content: string;
  timestamp: number;
}

/** Decode base64 string to Uint8Array. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Shared state across invocations (persists for the lifetime of the shell). */
interface PlaywrightState {
  /** Currently active targetId (the "current tab") */
  currentTarget: string | null;
  /** Per-tab snapshots keyed by targetId */
  snapshots: Map<string, TabSnapshot>;
  /** App tab ID to exclude */
  appTabId: string | null;
  /** HAR recorder instance (created lazily) */
  harRecorder: HarRecorder | null;
  /** Whether /.playwright/ directories have been created */
  sessionDirsCreated: boolean;
}

export const PLAYWRIGHT_COMMAND_NAMES = ['playwright-cli', 'playwright', 'puppeteer'] as const;

const sharedStateByBrowser = new WeakMap<BrowserAPI, WeakMap<VirtualFS, PlaywrightState>>();

/** Commands that invalidate ref snapshots because page state may have changed. */
const SNAPSHOT_INVALIDATING_COMMANDS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'goto', 'go-back', 'go-forward',
  'reload', 'select', 'check', 'uncheck', 'drag', 'dialog-accept', 'dialog-dismiss',
]);

/** Commands that can safely auto-save a fresh accessibility snapshot after success. */
const AUTO_SNAPSHOT_COMMANDS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'goto',
  'select', 'check', 'uncheck', 'drag', 'dialog-accept', 'dialog-dismiss',
]);

/** Format an ISO timestamp to be safe for filenames (replace : with -). */
function filenameSafeTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  return Number(value);
}

export function getSharedState(browser: BrowserAPI, fs: VirtualFS): PlaywrightState {
  let statesByFs = sharedStateByBrowser.get(browser);
  if (!statesByFs) {
    statesByFs = new WeakMap();
    sharedStateByBrowser.set(browser, statesByFs);
  }

  let state = statesByFs.get(fs);
  if (!state) {
    state = {
      currentTarget: null,
      snapshots: new Map(),
      appTabId: null,
      harRecorder: null,
      sessionDirsCreated: false,
    };
    statesByFs.set(fs, state);
  }

  return state;
}

function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof FsError) return err.code === 'EEXIST';
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: unknown }).code === 'EEXIST';
  }
  return err instanceof Error && err.message.includes('EEXIST');
}

const CLEAR_FOCUSABLE_ELEMENT_FUNCTION = `function() {
  const el = this;
  if (!(el instanceof HTMLElement)) return false;
  el.focus();
  const emitInput = () => el.dispatchEvent(new Event('input', { bubbles: true }));
  if (el.isContentEditable) {
    el.textContent = '';
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    emitInput();
    return true;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || 'value' in el) {
    el.value = '';
    emitInput();
    return true;
  }
  return false;
}`;

async function getCurrentPageLocation(browser: BrowserAPI): Promise<{ href: string; hostname: string; pathname: string }> {
  const raw = await browser.evaluate(
    `JSON.stringify({ href: location.href, hostname: location.hostname, pathname: location.pathname })`,
  );
  return JSON.parse(raw as string) as { href: string; hostname: string; pathname: string };
}

/** Ensure /.playwright/ directories exist. */
async function ensureSessionDirs(vfs: VirtualFS, state: PlaywrightState): Promise<void> {
  if (state.sessionDirsCreated) return;
  for (const dir of ['/.playwright', '/.playwright/snapshots', '/.playwright/screenshots']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        throw err;
      }
    }
  }
  state.sessionDirsCreated = true;
}

/** Take a snapshot and save it to /.playwright/snapshots/. Does NOT update in-memory state. Returns the file path. */
async function autoSaveSnapshot(
  browser: BrowserAPI,
  vfs: VirtualFS,
  state: PlaywrightState,
  targetId: string,
): Promise<string | null> {
  try {
    await browser.attachToPage(targetId);
    const pageInfo = await browser.evaluate(
      `JSON.stringify({ url: location.href, title: document.title })`,
    );
    const { url, title } = JSON.parse(pageInfo as string);
    const tree = await browser.getAccessibilityTree();
    const refToSelector = new Map<string, string>();
    const refToBackendNodeId = new Map<string, number>();
    const counter = { value: 0 };
    const snapshotLines = renderNode(tree, refToSelector, refToBackendNodeId, counter);
    const content = snapshotLines.join('\n');
    const output = [`Page URL: ${url}`, `Page Title: ${title}`, '', content].join('\n');

    const ts = filenameSafeTimestamp(new Date());
    const path = `/.playwright/snapshots/page-${ts}.yml`;
    await vfs.writeFile(path, output);
    return path;
  } catch {
    return null;
  }
}

/** Append a session log entry to /.playwright/session.md. */
async function logSession(
  vfs: VirtualFS,
  state: PlaywrightState,
  opts: {
    command: string;
    args: string[];
    result: CmdResult;
    snapshotPath: string | null;
    tabUrl?: string;
    targetId?: string | null;
  },
): Promise<void> {
  await ensureSessionDirs(vfs, state);
  const ts = new Date().toISOString();
  const cmdLine = `playwright-cli ${opts.command}${opts.args.length ? ' ' + opts.args.join(' ') : ''}`;
  const resultSummary = opts.result.exitCode === 0
    ? (opts.result.stdout.trim() || 'OK')
    : `Error: ${opts.result.stderr.trim()}`;

  const lines = [
    `### ${cmdLine}`,
    `- **Time**: ${ts}`,
  ];
  if (opts.tabUrl || opts.targetId) {
    const tabInfo = opts.tabUrl
      ? `${opts.tabUrl}${opts.targetId ? ` (targetId: ${opts.targetId})` : ''}`
      : `targetId: ${opts.targetId}`;
    lines.push(`- **Tab**: ${tabInfo}`);
  }
  lines.push(`- **Result**: ${resultSummary}`);
  if (opts.snapshotPath) {
    lines.push('', `[Snapshot](${opts.snapshotPath})`);
  }
  lines.push('---', '');

  const entry = lines.join('\n') + '\n';
  const sessionPath = '/.playwright/session.md';
  let existing = '';
  try {
    const content = await vfs.readFile(sessionPath);
    existing = typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
  } catch {
    // File doesn't exist yet
  }
  await vfs.writeFile(sessionPath, existing + entry);
}

function escapeYaml(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeCssAttr(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderNode(
  node: AccessibilityNode,
  refToSelector: Map<string, string>,
  refToBackendNodeId: Map<string, number>,
  counter: { value: number },
  indent: string = '',
): string[] {
  const lines: string[] = [];
  const role = normalizeAccessibilityText(node.role, 'unknown').toLowerCase();
  const name = normalizeAccessibilityText(node.name);
  const value = normalizeAccessibilityText(node.value);

  const skipRoles = ['none', 'presentation', 'generic', 'rootwebarea'];
  const needsRef =
    !skipRoles.includes(role) &&
    (name ||
      role === 'textbox' ||
      role === 'button' ||
      role === 'link' ||
      role === 'checkbox' ||
      role === 'radio');

  let ref = '';
  if (needsRef) {
    ref = `e${++counter.value}`;

    // Store backendNodeId for reliable ref-based clicking
    if (node.backendNodeId) {
      refToBackendNodeId.set(ref, node.backendNodeId);
    }

    const escapedName = escapeCssAttr(name);
    let selector = '';
    if (role === 'button' && name) {
      selector = `button[aria-label="${escapedName}"], button[title="${escapedName}"]`;
    } else if (role === 'link' && name) {
      selector = `a[aria-label="${escapedName}"], a[title="${escapedName}"]`;
    } else if (role === 'textbox') {
      if (name) {
        selector = `input[aria-label="${escapedName}"], textarea[aria-label="${escapedName}"], [contenteditable][aria-label="${escapedName}"], input[placeholder="${escapedName}"], textarea[placeholder="${escapedName}"], [contenteditable][placeholder="${escapedName}"], input[title="${escapedName}"], textarea[title="${escapedName}"], [contenteditable][title="${escapedName}"]`;
      } else {
        selector = `input, textarea, [contenteditable]`;
      }
    } else if (role === 'checkbox') {
      selector = `input[type="checkbox"]`;
    } else if (role === 'radio') {
      selector = `input[type="radio"]`;
    } else if (name) {
      selector = `[aria-label="${escapedName}"], [title="${escapedName}"]`;
    } else {
      selector = `[role="${role}"]`;
    }
    refToSelector.set(ref, selector);
  }

  let line = `${indent}- ${role}`;
  if (name) line += ` "${escapeYaml(name)}"`;
  if (ref) line += ` [ref=${ref}]`;
  if (value) line += `: "${escapeYaml(value)}"`;
  lines.push(line);

  if (node.children) {
    for (const child of node.children) {
      lines.push(...renderNode(child, refToSelector, refToBackendNodeId, counter, indent + '  '));
    }
  }
  return lines;
}

async function resolveAppTabId(
  browser: BrowserAPI,
  state: PlaywrightState,
): Promise<void> {
  if (state.appTabId) return;
  const pages = await browser.listPages();
  const appOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const appTab = pages.find(
    (p) => p.url.startsWith(appOrigin) && !p.url.includes('/preview/'),
  );
  if (appTab) state.appTabId = appTab.targetId;
}

function isAppTab(state: PlaywrightState, targetId: string): boolean {
  return targetId === state.appTabId;
}

function isChromeInternalUiTarget(page: PageInfo): boolean {
  const url = page.url.trim();
  const title = page.title.trim();

  return title === 'Omnibox Popup'
    || url.startsWith('chrome://')
    || url.startsWith('chrome-search://')
    || url.startsWith('chrome-untrusted://')
    || url.startsWith('devtools://')
    || (url.length === 0 && /popup$/i.test(title));
}

function isActionablePage(state: PlaywrightState, page: PageInfo): boolean {
  return !isAppTab(state, page.targetId) && !isChromeInternalUiTarget(page);
}

async function getActionablePages(
  browser: BrowserAPI,
  state: PlaywrightState,
): Promise<PageInfo[]> {
  await resolveAppTabId(browser, state);
  return (await browser.listPages()).filter((page) => isActionablePage(state, page));
}

/** Ensure we have a current target; auto-selects the active tab if needed. */
async function ensureTarget(
  browser: BrowserAPI,
  state: PlaywrightState,
): Promise<string | null> {
  const pages = await getActionablePages(browser, state);
  if (pages.length === 0) {
    state.currentTarget = null;
    return null;
  }

  if (state.currentTarget && pages.some((p) => p.targetId === state.currentTarget)) {
    return state.currentTarget;
  }

  state.currentTarget = null;
  const active = pages.find((p) => p.active);
  if (active) {
    state.currentTarget = active.targetId;
    return active.targetId;
  }
  const first = pages[0];
  if (first) {
    state.currentTarget = first.targetId;
    return first.targetId;
  }
  return null;
}

async function takeSnapshot(
  browser: BrowserAPI,
  state: PlaywrightState,
  targetId: string,
): Promise<{ snapshot: TabSnapshot; output: string }> {
  await browser.attachToPage(targetId);
  const pageInfo = await browser.evaluate(
    `JSON.stringify({ url: location.href, title: document.title })`,
  );
  const { url, title } = JSON.parse(pageInfo as string);
  const tree = await browser.getAccessibilityTree();
  const refToSelector = new Map<string, string>();
  const refToBackendNodeId = new Map<string, number>();
  const counter = { value: 0 };
  const snapshotLines = renderNode(tree, refToSelector, refToBackendNodeId, counter);
  const content = snapshotLines.join('\n');
  const snapshot: TabSnapshot = {
    url,
    title,
    refToSelector,
    refToBackendNodeId,
    content,
    timestamp: Date.now(),
  };
  state.snapshots.set(targetId, snapshot);

  const output = [
    `Page URL: ${url}`,
    `Page Title: ${title}`,
    '',
    content,
  ].join('\n');
  return { snapshot, output };
}

function formatHelp(commandName: string): string {
  const aliases = PLAYWRIGHT_COMMAND_NAMES.filter((name) => name !== commandName);
  return `Usage: ${commandName} <command> [args...]

Commands:
  open [url|/vfs/path] [--foreground|--fg]
                         Open a new tab (default: background). VFS paths are served via preview service worker.
  goto <url>             Navigate current tab to URL
  click <ref>            Click element by ref (e.g. e5)
  type <text>            Type text into focused element
  fill <ref> <text>      Fill an input by ref with text
  snapshot               Print accessibility tree with refs
  screenshot [--filename=path] [--max-width=N] [--fullPage=true]
                         Take screenshot. --max-width downscales the image
                         if wider than N pixels (e.g. --max-width=1024).
  eval <expression>      Evaluate JavaScript in tab
  dblclick <ref> [btn]   Double-click element by ref
  hover <ref>            Hover over element by ref
  select <ref> <val>     Select value in <select> element
  check <ref>            Check a checkbox/radio
  uncheck <ref>          Uncheck a checkbox/radio
  drag <start> <end>     Drag from one element to another
  eval-file <path> [--output=<path>]
                         Evaluate a JS file in the page. Reads the file from
                         VFS, evaluates in browser context. With --output,
                         saves the result to file instead of printing to stdout.
  press <key>            Press a keyboard key (e.g. Enter, Tab)
  resize <w> <h>         Resize viewport to width x height
  dialog-accept [text]   Accept a JavaScript dialog
  dialog-dismiss         Dismiss a JavaScript dialog
  go-back                Navigate back
  go-forward             Navigate forward
  reload                 Reload current tab
  tab-list               List open tabs
  tab-new [url] [--foreground|--fg]
                         Open new tab (default: background)
  tab-select <index>     Switch to tab by index
  tab-close [index]      Close tab (default: current)
  close                  Close current tab
  record [url] [--filter=<js-expr>]
                         Open tab with HAR recording enabled
  stop-recording <id>    Stop recording and save HAR
  cookie-list            List all cookies
  cookie-get <name>      Get cookie by name
  cookie-set <name> <value> [flags]
                         Set a cookie (--domain, --path, --secure, --httpOnly, --expires)
  cookie-delete <name>   Delete a cookie (--domain, --path)
  cookie-clear           Clear all cookies
  localstorage-list      List all localStorage entries
  localstorage-get <key> Get localStorage value
  localstorage-set <key> <value>
                         Set localStorage value
  localstorage-delete <key>
                         Delete localStorage entry
  localstorage-clear     Clear all localStorage
  sessionstorage-list    List all sessionStorage entries
  sessionstorage-get <key>
                         Get sessionStorage value
  sessionstorage-set <key> <value>
                         Set sessionStorage value
  sessionstorage-delete <key>
                         Delete sessionStorage entry
  sessionstorage-clear   Clear all sessionStorage
  help                   Show this help message

Aliases: ${aliases.join(', ')}`;
}

/** Parse --key=value flags from args, returning remaining positional args + flags. */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = 'true';
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

type CmdResult = { stdout: string; stderr: string; exitCode: number };

export function createPlaywrightCommand(
  name: string,
  browser: BrowserAPI | null | undefined,
  fs: VirtualFS,
): Command {
  const helpText = formatHelp(name);
  const state = browser ? getSharedState(browser, fs) : null;

  return defineCommand(name, async (args): Promise<CmdResult> => {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
      return { stdout: helpText + '\n', stderr: '', exitCode: 0 };
    }

    if (!browser || !state) {
      return {
        stdout: '',
        stderr: `${name}: browser APIs are unavailable in this environment\n`,
        exitCode: 1,
      };
    }

    const subcommand = args[0];
    const subArgs = args.slice(1);
    const { positional, flags } = parseFlags(subArgs);

    let result: CmdResult;
    try {
      switch (subcommand) {
        case 'open':
        case 'tab-new': {
          const url = positional[0] || 'about:blank';
          const foreground = flags['foreground'] === 'true' || flags['fg'] === 'true';

          const previousTarget = await ensureTarget(browser, state);
          await resolveAppTabId(browser, state);
          const targetId = await browser.createPage(url);
          if (foreground || !previousTarget) {
            state.currentTarget = targetId;
          }
          result = { stdout: `Opened tab (targetId: ${targetId}) at ${url}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'goto': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'goto requires a URL\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.navigate(positional[0]);
          state.snapshots.delete(targetId);
          result = { stdout: `Navigated to ${positional[0]}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'snapshot': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const { output } = await takeSnapshot(browser, state, targetId);
          if (flags['filename']) {
            await fs.writeFile(flags['filename'], output);
            result = { stdout: `Snapshot saved to ${flags['filename']}\n`, stderr: '', exitCode: 0 }; break;
          }
          result = { stdout: output + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'screenshot': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          // Ref-based screenshot
          let clip: { x: number; y: number; width: number; height: number } | undefined;
          if (positional[0] && positional[0].startsWith('e')) {
            const snapshot = state.snapshots.get(targetId);
            if (!snapshot) {
              result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
            }
            await browser.attachToPage(targetId);

            // Prefer backendNodeId for reliable element resolution
            const backendNodeId = snapshot.refToBackendNodeId.get(positional[0]);
            if (backendNodeId) {
              const transport = browser.getTransport();
              const sessionId = browser.getSessionId();
              await transport.send('DOM.enable', {}, sessionId!);
              await transport.send('Runtime.enable', {}, sessionId!);
              const resolveResult = await transport.send('DOM.resolveNode', { backendNodeId }, sessionId!);
              const obj = resolveResult['object'] as { objectId?: string } | undefined;
              if (obj?.objectId) {
                const boxResult = await transport.send('Runtime.callFunctionOn', {
                  objectId: obj.objectId,
                  functionDeclaration: `function() {
                    this.scrollIntoView({ block: 'center' });
                    const r = this.getBoundingClientRect();
                    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
                  }`,
                  returnByValue: true,
                }, sessionId!);
                const boxValue = (boxResult['result'] as { value?: { x: number; y: number; width: number; height: number } })?.value;
                if (boxValue) {
                  clip = boxValue;
                }
              }
            } else {
              // Fall back to CSS selector
              const selector = snapshot.refToSelector.get(positional[0]);
              if (!selector) {
                result = { stdout: '', stderr: `Unknown ref "${positional[0]}"\n`, exitCode: 1 }; break;
              }
              const rectJson = await browser.evaluate(
                `(function() {
                  const el = document.querySelector(${JSON.stringify(selector.split(',')[0].trim())});
                  if (!el) return null;
                  el.scrollIntoView({ block: 'center' });
                  const r = el.getBoundingClientRect();
                  return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
                })()`,
              );
              if (rectJson) {
                clip = JSON.parse(rectJson as string);
              }
            }
          }

          await browser.attachToPage(targetId);
          const maxWidth = flags['max-width'] ? parseInt(flags['max-width'], 10) : undefined;
          const base64 = await browser.screenshot({
            fullPage: flags['fullPage'] === 'true',
            ...(clip ? { clip } : {}),
            ...(maxWidth ? { maxWidth } : {}),
          });
          const savePath = flags['filename'] || `/tmp/screenshot-${Date.now()}.png`;
          const bytes = base64ToBytes(base64);
          await fs.writeFile(savePath, bytes);
          // Archive screenshot to /.playwright/screenshots/
          try {
            await ensureSessionDirs(fs, state);
            const archivePath = `/.playwright/screenshots/screenshot-${filenameSafeTimestamp(new Date())}.png`;
            await fs.writeFile(archivePath, bytes);
          } catch {
            // Best-effort
          }
          const sizeKB = Math.round(bytes.length / 1024);
          result = { stdout: `Screenshot saved to ${savePath} (${sizeKB} KB)\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'click': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'click requires a ref (e.g. e5)\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);

          // Prefer backendNodeId for reliable clicking
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (backendNodeId) {
            await browser.clickByBackendNodeId(backendNodeId);
            state.snapshots.delete(targetId);
            result = { stdout: `Clicked ${ref}\n`, stderr: '', exitCode: 0 }; break;
          }

          // Fall back to CSS selector
          const selector = snapshot.refToSelector.get(ref);
          if (!selector) {
            result = { stdout: '', stderr: `Unknown ref "${ref}". Available: ${[...snapshot.refToSelector.keys()].slice(0, 10).join(', ')}...\n`, exitCode: 1 }; break;
          }
          await browser.click(selector);
          state.snapshots.delete(targetId);
          result = { stdout: `Clicked ${ref}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'type': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'type requires text\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const text = positional.join(' ');
          await browser.type(text);
          result = { stdout: `Typed: ${text}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'fill': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'fill requires <ref> <text>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const fillText = positional.slice(1).join(' ');

          // Prefer backendNodeId for reliable element targeting
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (backendNodeId) {
            // Click to focus, then clear and type
            await browser.clickByBackendNodeId(backendNodeId);
            // Clear via DOM using resolved node
            const transport = browser.getTransport();
            const sessionId = browser.getSessionId();
            await transport.send('DOM.enable', {}, sessionId!);
            await transport.send('Runtime.enable', {}, sessionId!);
            const resolveResult = await transport.send('DOM.resolveNode', { backendNodeId }, sessionId!);
            const obj = resolveResult['object'] as { objectId?: string } | undefined;
            if (obj?.objectId) {
              await transport.send('Runtime.callFunctionOn', {
                objectId: obj.objectId,
                functionDeclaration: CLEAR_FOCUSABLE_ELEMENT_FUNCTION,
                returnByValue: true,
              }, sessionId!);
            }
            await browser.type(fillText);
            state.snapshots.delete(targetId);
            result = { stdout: `Filled ${ref} with: ${fillText}\n`, stderr: '', exitCode: 0 }; break;
          }

          // Fall back to CSS selector
          const selector = snapshot.refToSelector.get(ref);
          if (!selector) {
            result = { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 }; break;
          }
          await browser.click(selector);
          await browser.evaluate(
            `(function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (el) {
                return (${CLEAR_FOCUSABLE_ELEMENT_FUNCTION}).call(el);
              }
              return false;
            })()`,
          );
          await browser.type(fillText);
          state.snapshots.delete(targetId);
          result = { stdout: `Filled ${ref} with: ${fillText}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'eval': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'eval requires an expression\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const expression = positional.join(' ');
          const evalResult = await browser.evaluate(expression);
          const output = typeof evalResult === 'string' ? evalResult : JSON.stringify(evalResult, null, 2);
          result = { stdout: (output ?? 'undefined') + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'eval-file': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'eval-file requires a file path\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const scriptPath = positional[0];
          const outputPath = flags['output'];

          let scriptContent: string;
          try {
            scriptContent = await fs.readTextFile(scriptPath);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            result = { stdout: '', stderr: `eval-file: cannot read ${scriptPath}: ${msg}\n`, exitCode: 1 }; break;
          }

          await browser.attachToPage(targetId);
          const fileEvalResult = await browser.evaluate(scriptContent);
          const fileOutput = typeof fileEvalResult === 'string' ? fileEvalResult : JSON.stringify(fileEvalResult, null, 2);

          if (outputPath) {
            const outputContent = fileOutput ?? 'null';
            await fs.writeFile(outputPath, outputContent);
            const sizeKB = Math.round(new TextEncoder().encode(outputContent).length / 1024);
            result = { stdout: `Result saved to ${outputPath} (${sizeKB} KB)\n`, stderr: '', exitCode: 0 };
          } else {
            result = { stdout: (fileOutput ?? 'undefined') + '\n', stderr: '', exitCode: 0 };
          }
          break;
        }

        case 'press': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'press requires a key name\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const key = positional[0];
          // Use CDP Input.dispatchKeyEvent
          const transport = browser.getTransport();
          const sessionId = browser.getSessionId();
          await transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId!);
          await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId!);
          result = { stdout: `Pressed ${key}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'go-back': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate('history.back()');
          state.snapshots.delete(targetId);
          result = { stdout: 'Navigated back\n', stderr: '', exitCode: 0 }; break;
        }

        case 'go-forward': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate('history.forward()');
          state.snapshots.delete(targetId);
          result = { stdout: 'Navigated forward\n', stderr: '', exitCode: 0 }; break;
        }

        case 'reload': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.sendCDP('Page.reload');
          result = { stdout: 'Reloaded\n', stderr: '', exitCode: 0 }; break;
        }

        case 'tab-list': {
          const pages = await getActionablePages(browser, state);
          if (pages.length === 0) {
            result = { stdout: 'No tabs open\n', stderr: '', exitCode: 0 }; break;
          }
          const lines = pages.map((p, i) => {
            const isCurrent = p.targetId === state.currentTarget;
            const isActive = !!p.active;
            const marker = isCurrent ? '→ ' : isActive ? '* ' : '  ';
            return `${marker}${i}: ${p.title} (${p.url})`;
          });
          result = { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'tab-select': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'tab-select requires an index\n', exitCode: 1 }; break;
          }
          const index = parseInt(positional[0], 10);
          const pages = await getActionablePages(browser, state);
          if (index < 0 || index >= pages.length) {
            result = { stdout: '', stderr: `Tab index ${index} out of range (0-${pages.length - 1})\n`, exitCode: 1 }; break;
          }
          state.currentTarget = pages[index].targetId;
          result = { stdout: `Switched to tab ${index}: ${pages[index].title}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'tab-close':
        case 'close': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab to close.\n', exitCode: 1 }; break;
          }
          // If index is given, close that tab instead
          if (positional.length > 0) {
            const index = parseNonNegativeInteger(positional[0]);
            if (index === null) {
              result = { stdout: '', stderr: `Invalid tab index "${positional[0]}"\n`, exitCode: 1 }; break;
            }
            const pages = await getActionablePages(browser, state);
            if (index < 0 || index >= pages.length) {
              result = { stdout: '', stderr: `Tab index ${index} out of range\n`, exitCode: 1 }; break;
            }
            const closeTarget = pages[index].targetId;
            const transport = browser.getTransport();
            await transport.send('Target.closeTarget', { targetId: closeTarget });
            state.snapshots.delete(closeTarget);
            if (state.currentTarget === closeTarget) state.currentTarget = null;
            result = { stdout: `Closed tab ${index}\n`, stderr: '', exitCode: 0 }; break;
          }
          // Close current tab
          const transport = browser.getTransport();
          await transport.send('Target.closeTarget', { targetId });
          state.snapshots.delete(targetId);
          state.currentTarget = null;
          result = { stdout: 'Closed current tab\n', stderr: '', exitCode: 0 }; break;
        }

        case 'dblclick': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'dblclick requires a ref (e.g. e5)\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const button = (positional[1] || 'left') as 'left' | 'right' | 'middle';
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (!backendNodeId) {
            result = { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 }; break;
          }
          await browser.dblclickByBackendNodeId(backendNodeId, button);
          state.snapshots.delete(targetId);
          result = { stdout: `Double-clicked ${ref}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'hover': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'hover requires a ref (e.g. e5)\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (!backendNodeId) {
            result = { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 }; break;
          }
          await browser.hoverByBackendNodeId(backendNodeId);
          result = { stdout: `Hovered ${ref}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'select': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'select requires <ref> <value>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const value = positional.slice(1).join(' ');
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (!backendNodeId) {
            result = { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 }; break;
          }
          await browser.selectByBackendNodeId(backendNodeId, value);
          state.snapshots.delete(targetId);
          result = { stdout: `Selected "${value}" on ${ref}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'check': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'check requires a ref (e.g. e5)\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (!backendNodeId) {
            result = { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 }; break;
          }
          const action = await browser.setCheckedByBackendNodeId(backendNodeId, true);
          if (action === 'toggled') state.snapshots.delete(targetId);
          result = { stdout: action === 'already' ? `${ref} already checked\n` : `Checked ${ref}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'uncheck': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'uncheck requires a ref (e.g. e5)\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const ref = positional[0];
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const backendNodeId = snapshot.refToBackendNodeId.get(ref);
          if (!backendNodeId) {
            result = { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 }; break;
          }
          const action = await browser.setCheckedByBackendNodeId(backendNodeId, false);
          if (action === 'toggled') state.snapshots.delete(targetId);
          result = { stdout: action === 'already' ? `${ref} already unchecked\n` : `Unchecked ${ref}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'drag': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'drag requires <startRef> <endRef>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const startRef = positional[0];
          const endRef = positional[1];
          const snapshot = state.snapshots.get(targetId);
          if (!snapshot) {
            result = { stdout: '', stderr: 'No snapshot available. Run "snapshot" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const startNode = snapshot.refToBackendNodeId.get(startRef);
          const endNode = snapshot.refToBackendNodeId.get(endRef);
          if (!startNode) {
            result = { stdout: '', stderr: `Unknown ref "${startRef}"\n`, exitCode: 1 }; break;
          }
          if (!endNode) {
            result = { stdout: '', stderr: `Unknown ref "${endRef}"\n`, exitCode: 1 }; break;
          }
          await browser.dragByBackendNodeIds(startNode, endNode);
          state.snapshots.delete(targetId);
          result = { stdout: `Dragged ${startRef} to ${endRef}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'resize': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'resize requires <width> <height>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          const w = parseInt(positional[0], 10);
          const h = parseInt(positional[1], 10);
          if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
            result = { stdout: '', stderr: 'resize requires positive integer width and height\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const transport = browser.getTransport();
          const sessionId = browser.getSessionId();
          await transport.send('Emulation.setDeviceMetricsOverride', {
            width: w,
            height: h,
            deviceScaleFactor: 1,
            mobile: false,
          }, sessionId!);
          state.snapshots.delete(targetId);
          result = { stdout: `Resized viewport to ${w}x${h}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'dialog-accept': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const transport = browser.getTransport();
          const sessionId = browser.getSessionId();
          await transport.send('Page.enable', {}, sessionId!);
          const promptText = positional.length > 0 ? positional.join(' ') : undefined;
          await transport.send('Page.handleJavaScriptDialog', {
            accept: true,
            ...(promptText !== undefined ? { promptText } : {}),
          }, sessionId!);
          result = { stdout: `Accepted dialog${promptText ? ` with "${promptText}"` : ''}\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'dialog-dismiss': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const transport = browser.getTransport();
          const sessionId = browser.getSessionId();
          await transport.send('Page.enable', {}, sessionId!);
          await transport.send('Page.handleJavaScriptDialog', { accept: false }, sessionId!);
          result = { stdout: 'Dismissed dialog\n', stderr: '', exitCode: 0 }; break;
        }

        // --- Cookie commands (via CDP Network domain) ---

        case 'cookie-list': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const cdpCookies = await browser.sendCDP('Network.getCookies');
          const cookies = (cdpCookies['cookies'] as Array<Record<string, unknown>>) ?? [];
          if (cookies.length === 0) {
            result = { stdout: 'No cookies\n', stderr: '', exitCode: 0 }; break;
          }
          const lines = cookies.map((c) =>
            `${c['name']}=${c['value']}\tDomain=${c['domain']}\tPath=${c['path']}\tSecure=${c['secure']}\tHttpOnly=${c['httpOnly']}\tExpires=${c['expires']}`,
          );
          result = { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'cookie-get': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'cookie-get requires a cookie name\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const cookieName = positional[0];
          const cdpGetCookies = await browser.sendCDP('Network.getCookies');
          const cookies = (cdpGetCookies['cookies'] as Array<Record<string, unknown>>) ?? [];
          const matched = cookies.filter((c) => c['name'] === cookieName);
          if (matched.length === 0) {
            result = { stdout: '', stderr: `Cookie "${cookieName}" not found\n`, exitCode: 1 }; break;
          }
          const lines = matched.map((c) =>
            `${c['name']}=${c['value']}\tDomain=${c['domain']}\tPath=${c['path']}\tSecure=${c['secure']}\tHttpOnly=${c['httpOnly']}\tExpires=${c['expires']}`,
          );
          result = { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'cookie-set': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'cookie-set requires <name> <value>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const pageLocation = await getCurrentPageLocation(browser);
          const params: Record<string, unknown> = {
            name: positional[0],
            value: positional[1],
          };
          if (flags['domain']) params['domain'] = flags['domain'];
          if (flags['path']) params['path'] = flags['path'];
          if (flags['secure'] === 'true') params['secure'] = true;
          if (flags['httpOnly'] === 'true') params['httpOnly'] = true;
          if (flags['expires']) params['expires'] = parseFloat(flags['expires']);
          if (!params['domain'] && !params['path']) {
            params['url'] = pageLocation.href;
          }
          await browser.sendCDP('Network.setCookie', params);
          result = { stdout: `Cookie "${positional[0]}" set\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'cookie-delete': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'cookie-delete requires a cookie name\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const delParams: Record<string, unknown> = { name: positional[0] };
          if (flags['domain']) delParams['domain'] = flags['domain'];
          if (flags['path']) delParams['path'] = flags['path'];
          if (!delParams['domain'] && !delParams['path']) {
            const pageLocation = await getCurrentPageLocation(browser);
            delParams['url'] = pageLocation.href;
          }
          await browser.sendCDP('Network.deleteCookies', delParams);
          result = { stdout: `Cookie "${positional[0]}" deleted\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'cookie-clear': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.sendCDP('Network.clearBrowserCookies');
          result = { stdout: 'All cookies cleared\n', stderr: '', exitCode: 0 }; break;
        }

        // --- localStorage commands (via evaluate) ---

        case 'localstorage-list': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const raw = await browser.evaluate('JSON.stringify(Object.entries(localStorage))') as string;
          const entries = JSON.parse(raw) as [string, string][];
          if (entries.length === 0) {
            result = { stdout: 'No localStorage entries\n', stderr: '', exitCode: 0 }; break;
          }
          const lines = entries.map(([k, v]) => `${k}=${v}`);
          result = { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'localstorage-get': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'localstorage-get requires a key\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const val = await browser.evaluate(`localStorage.getItem(${JSON.stringify(positional[0])})`);
          if (val === null) {
            result = { stdout: '', stderr: `Key "${positional[0]}" not found in localStorage\n`, exitCode: 1 }; break;
          }
          result = { stdout: val + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'localstorage-set': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'localstorage-set requires <key> <value>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate(`localStorage.setItem(${JSON.stringify(positional[0])}, ${JSON.stringify(positional.slice(1).join(' '))})`);
          result = { stdout: `localStorage "${positional[0]}" set\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'localstorage-delete': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'localstorage-delete requires a key\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate(`localStorage.removeItem(${JSON.stringify(positional[0])})`);
          result = { stdout: `localStorage "${positional[0]}" deleted\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'localstorage-clear': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate('localStorage.clear()');
          result = { stdout: 'localStorage cleared\n', stderr: '', exitCode: 0 }; break;
        }

        // --- sessionStorage commands (via evaluate) ---

        case 'sessionstorage-list': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const raw = await browser.evaluate('JSON.stringify(Object.entries(sessionStorage))') as string;
          const entries = JSON.parse(raw) as [string, string][];
          if (entries.length === 0) {
            result = { stdout: 'No sessionStorage entries\n', stderr: '', exitCode: 0 }; break;
          }
          const lines = entries.map(([k, v]) => `${k}=${v}`);
          result = { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'sessionstorage-get': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'sessionstorage-get requires a key\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          const val = await browser.evaluate(`sessionStorage.getItem(${JSON.stringify(positional[0])})`);
          if (val === null) {
            result = { stdout: '', stderr: `Key "${positional[0]}" not found in sessionStorage\n`, exitCode: 1 }; break;
          }
          result = { stdout: val + '\n', stderr: '', exitCode: 0 }; break;
        }

        case 'sessionstorage-set': {
          if (positional.length < 2) {
            result = { stdout: '', stderr: 'sessionstorage-set requires <key> <value>\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate(`sessionStorage.setItem(${JSON.stringify(positional[0])}, ${JSON.stringify(positional.slice(1).join(' '))})`);
          result = { stdout: `sessionStorage "${positional[0]}" set\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'sessionstorage-delete': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'sessionstorage-delete requires a key\n', exitCode: 1 }; break;
          }
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate(`sessionStorage.removeItem(${JSON.stringify(positional[0])})`);
          result = { stdout: `sessionStorage "${positional[0]}" deleted\n`, stderr: '', exitCode: 0 }; break;
        }

        case 'sessionstorage-clear': {
          const targetId = await ensureTarget(browser, state);
          if (!targetId) {
            result = { stdout: '', stderr: 'No tab available. Use "open" first.\n', exitCode: 1 }; break;
          }
          await browser.attachToPage(targetId);
          await browser.evaluate('sessionStorage.clear()');
          result = { stdout: 'sessionStorage cleared\n', stderr: '', exitCode: 0 }; break;
        }

        case 'record': {
          const url = positional[0] || 'about:blank';
          const filterCode = flags['filter'];
          await resolveAppTabId(browser, state);
          const newTargetId = await browser.createPage(url);
          const transport = browser.getTransport();
          const attachResult = await transport.send('Target.attachToTarget', {
            targetId: newTargetId,
            flatten: true,
          });
          const sessionId = attachResult['sessionId'] as string;
          if (!state.harRecorder) {
            state.harRecorder = new HarRecorder(transport, fs);
          }
          const recordingId = await state.harRecorder.startRecording(newTargetId, sessionId, filterCode);
          state.currentTarget = newTargetId;
          result = {
            stdout: `Recording started (targetId: ${newTargetId}, recordingId: ${recordingId}) at ${url}\nHAR saved to /recordings/${recordingId}/\n`,
            stderr: '',
            exitCode: 0,
          }; break;
        }

        case 'stop-recording': {
          if (positional.length === 0) {
            result = { stdout: '', stderr: 'stop-recording requires a recordingId\n', exitCode: 1 }; break;
          }
          const recordingId = positional[0];
          if (!state.harRecorder) {
            result = { stdout: '', stderr: `Recording not found: ${recordingId}\n`, exitCode: 1 }; break;
          }
          const recordingsPath = await state.harRecorder.stopRecording(recordingId);
          result = { stdout: `Recording stopped. HAR files saved to ${recordingsPath}\n`, stderr: '', exitCode: 0 }; break;
        }

        default:
          result = { stdout: '', stderr: `Unknown command: ${subcommand}\nRun "playwright-cli help" for usage.\n`, exitCode: 1 }; break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { stdout: '', stderr: `Error: ${msg}\n`, exitCode: 1 };
    }

    if (result.exitCode === 0 && state.currentTarget && SNAPSHOT_INVALIDATING_COMMANDS.has(subcommand)) {
      state.snapshots.delete(state.currentTarget);
    }

    // Session history logging (best-effort, never fails the command)
    try {
      // Get current tab info for the log entry
      let tabUrl: string | undefined;
      const targetId = state.currentTarget;
      if (targetId) {
        const snap = state.snapshots.get(targetId);
        if (snap) tabUrl = snap.url;
      }

      // Auto-snapshot for state-changing commands (only on success)
      let snapshotPath: string | null = null;
      if (AUTO_SNAPSHOT_COMMANDS.has(subcommand) && result.exitCode === 0 && state.currentTarget) {
        snapshotPath = await autoSaveSnapshot(browser, fs, state, state.currentTarget);
      }

      // Log the session entry
      await logSession(fs, state, {
        command: subcommand,
        args: subArgs,
        result,
        snapshotPath,
        tabUrl,
        targetId,
      });
    } catch {
      // Session logging is best-effort
    }

    return result;
  });
}
