/**
 * Shared state, flag parsing, and small utilities for the playwright-cli
 * command family.
 */

import { base64ToUint8 } from '@slicc/shared-ts';
import { createLogger } from '../../../base/logger.js';
import { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY } from '../../../base/tray-storage-keys.js';

export { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY };

import { FsError, type VirtualFS } from '../../../fs/index.js';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import type { PlaywrightState } from './types.js';

export const PLAYWRIGHT_COMMAND_NAMES = ['playwright-cli', 'playwright', 'puppeteer'] as const;

/**
 * Duck types for the CDP surface this module needs — avoids shell → cdp
 * layer back-edges (`docs/review-patterns.md` § Layer-stack import direction).
 * Callers pass the real `BrowserAPI`; only the methods/fields below are used.
 */
interface PlaywrightPageInfo {
  targetId: string;
  title: string;
  url: string;
}

interface PlaywrightFrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
  name: string;
  securityOrigin?: string;
}

interface PlaywrightBrowserAPI {
  evaluate(expression: string): Promise<unknown>;
  getFrameTree(): Promise<PlaywrightFrameInfo[]>;
  listPages(): Promise<PlaywrightPageInfo[]>;
  listAllTargets?: () => Promise<PlaywrightPageInfo[]>;
  withTab<T>(targetId: string, fn: () => Promise<T>): Promise<T>;
}

const sharedStateByBrowser = new WeakMap<object, WeakMap<VirtualFS, PlaywrightState>>();
const log = createLogger('playwright');

export function getSharedState(browser: PlaywrightBrowserAPI, fs: VirtualFS): PlaywrightState {
  let statesByFs = sharedStateByBrowser.get(browser);
  if (!statesByFs) {
    statesByFs = new WeakMap();
    sharedStateByBrowser.set(browser, statesByFs);
  }

  let state = statesByFs.get(fs);
  if (!state) {
    state = {
      snapshots: new Map(),
      appTabId: null,
      harRecorder: null,
      sessionDirsCreated: false,
      teleportWatchers: new Map(),
      consoleMessages: new Map(),
      consoleCleanup: new Map(),
      networkRequests: new Map(),
      networkRequestIndex: new Map(),
      networkCleanup: new Map(),
      routes: new Map(),
      routeCleanup: new Map(),
      lastMousePosition: new Map(),
    };
    statesByFs.set(fs, state);
  }

  return state;
}

/** Snapshot element ref: `e5` in the main frame, `f1e5` in a child frame. */
export const ELEMENT_REF_RE = /^(f[0-9]+)?e[0-9]+$/;

/** True when `token` is a snapshot ref (`e5`, `f1e5`), not a file path. */
export function isElementRef(token: string): boolean {
  return ELEMENT_REF_RE.test(token);
}

/** Parse a ref like 'f1e5' into { framePrefix: 'f1', isIframe: true } or 'e5' into { framePrefix: '', isIframe: false } */
export function parseRef(ref: string): { framePrefix: string; isIframe: boolean } {
  const match = ref.match(/^(f[0-9]+)(e[0-9]+)$/);
  if (match) return { framePrefix: match[1], isIframe: true };
  return { framePrefix: '', isIframe: false };
}

/** Decode base64 string to Uint8Array — thin re-export of `@slicc/shared-ts`. */
export const base64ToBytes = base64ToUint8;

/** Commands that invalidate ref snapshots because page state may have changed. */
const _SNAPSHOT_INVALIDATING_COMMANDS = new Set([
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'goto',
  'navigate',
  'go-back',
  'go-forward',
  'reload',
  'select',
  'check',
  'uncheck',
  'drag',
  'dialog-accept',
  'dialog-dismiss',
]);

/** Commands that can safely auto-save a fresh accessibility snapshot after success. */
export const AUTO_SNAPSHOT_COMMANDS = new Set([
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'goto',
  'navigate',
  'select',
  'check',
  'uncheck',
  'drag',
  'dialog-accept',
  'dialog-dismiss',
  'drop',
]);

/** Format an ISO timestamp to be safe for filenames (replace : with -). */
export function filenameSafeTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

function _parseNonNegativeInteger(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  return Number(value);
}

export function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof FsError) return err.code === 'EEXIST';
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: unknown }).code === 'EEXIST';
  }
  return err instanceof Error && err.message.includes('EEXIST');
}

/** Fallback for React-controlled inputs: uses native value setter + dispatches input/change events. */
export const REACT_FILL_FALLBACK_FUNCTION = `function(text) {
  const el = this;
  const tag = el.tagName;
  const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

/** Read back the current value of an input/textarea/contenteditable. */
export const READ_INPUT_VALUE_FUNCTION = `function() {
  const el = this;
  if (el.isContentEditable) return el.textContent || '';
  return el.value ?? '';
}`;

export const CLEAR_FOCUSABLE_ELEMENT_FUNCTION = `function() {
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

/**
 * Parse JSON produced by our own in-page `JSON.stringify`. A malformed value
 * means the page evaluation was hijacked or truncated — fail with the context
 * of WHAT was being read rather than a bare SyntaxError.
 */
export function parsePageJson<T>(raw: unknown, what: string): T {
  try {
    return JSON.parse(raw as string) as T;
  } catch {
    throw new Error(`could not parse ${what} from the page (got: ${String(raw).slice(0, 80)})`);
  }
}

export async function getCurrentPageLocation(
  browser: PlaywrightBrowserAPI
): Promise<{ href: string; hostname: string; pathname: string }> {
  const raw = await browser.evaluate(
    `JSON.stringify({ href: location.href, hostname: location.hostname, pathname: location.pathname })`
  );
  try {
    return JSON.parse(raw as string) as { href: string; hostname: string; pathname: string };
  } catch {
    throw new Error(
      `could not read the page location (evaluate returned: ${String(raw).slice(0, 80)})`
    );
  }
}

import { type ArgSpec, parseArgs } from '../../arg-parser.js';

/**
 * Flag spec for the playwright-cli command family.
 * Replaces the former hand-rolled VALUE_FLAGS + parseFlags machinery with the
 * shared `parseArgs` wrapper over `mri`.
 */
export const PLAYWRIGHT_FLAG_SPEC: ArgSpec = {
  string: [
    'tab',
    'frame',
    'filename',
    'max-width',
    'runtime',
    'timeout',
    'filter',
    'output',
    'start',
    'return',
    'teleport-start',
    'teleport-return',
    'teleport-runtime',
    'domain',
    'path',
    'expires',
    'method',
    'depth',
    'modifiers',
    'regex',
    'type',
    'sameSite',
    'data',
    'status',
    'body',
    'content-type',
    'header',
    'style',
  ],
  boolean: [
    'boxes',
    'clear',
    'discover',
    'foreground',
    'fg',
    'full-page',
    'fullPage',
    'hide',
    'httpOnly',
    'hires',
    'list',
    'mobile',
    'off',
    'secure',
    'static',
    'submit',
  ],
  alias: {
    foreground: 'fg',
    'full-page': 'fullPage',
  },
};

/**
 * Parse playwright-cli flags via the shared arg-parser.
 * Returns `{ positional, flags }` with flags as `Record<string, string>` to
 * preserve backward compatibility with all handler call sites.
 */
export function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  // mri hardwires --no-X → { X: false }. Rewrite --no-iframes to an opaque
  // token so it survives as a plain flag, then restore the canonical key after.
  const safeArgs = args.map((a) =>
    a === '--no-iframes' || a.startsWith('--no-iframes=')
      ? a.replace('--no-iframes', '--_noiframes')
      : a
  );
  const parsed = parseArgs(safeArgs, PLAYWRIGHT_FLAG_SPEC);
  const flags: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed.flags)) {
    const canonicalKey = key === '_noiframes' ? 'no-iframes' : key;
    if (val === true) flags[canonicalKey] = 'true';
    else if (val === false) continue;
    else if (val !== undefined) flags[canonicalKey] = String(val);
  }
  return { positional: parsed.positionals, flags };
}

/** Parse and validate the --tab <targetId> flag. Returns targetId or error message. */
export function requireTab(
  flags: Record<string, string>
): { targetId: string } | { error: string } {
  const tabId = flags['tab'];
  if (!tabId) {
    return {
      error: "Error: --tab <targetId> is required. Run 'playwright-cli tab-list' to get tab IDs.\n",
    };
  }
  return { targetId: tabId };
}

/** Resolve and validate an optional --frame ID against the currently attached tab. */
export async function resolveFrame(
  browser: PlaywrightBrowserAPI,
  flags: Record<string, string>
): Promise<PlaywrightFrameInfo | null> {
  const frameId = flags['frame'];
  if (!frameId) return null;

  const frame = (await browser.getFrameTree()).find((candidate) => candidate.frameId === frameId);
  if (frame) return frame;

  const targetId = flags['tab'] ?? '<targetId>';
  throw new Error(
    `Unknown frame ID "${frameId}" for tab ${targetId}. Run 'playwright-cli frames --tab=${targetId}' to list frame IDs.`
  );
}

/** Whether a multi-browser tray is configured in the page or worker localStorage shim. */
function isTrayConfigured(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return false;
    return !!(storage.getItem(TRAY_WORKER_STORAGE_KEY) || storage.getItem(TRAY_JOIN_STORAGE_KEY));
  } catch {
    return false;
  }
}

/** List local targets plus any remote tray/follower targets visible through panel RPC. */
export async function listAllTargetsWithRemote(
  browser: PlaywrightBrowserAPI
): Promise<PlaywrightPageInfo[]> {
  if (typeof browser.listAllTargets !== 'function') return browser.listPages();

  const pages = await browser.listAllTargets();
  const rpc = isTrayConfigured() ? getPanelRpcClient() : null;
  if (!rpc) return pages;

  try {
    const { targets } = await rpc.call('list-remote-targets', undefined, { timeoutMs: 3000 });
    const seen = new Set(pages.map((page) => page.targetId));
    for (const target of targets) {
      if (seen.has(target.targetId)) continue;
      seen.add(target.targetId);
      pages.push({ targetId: target.targetId, title: target.title, url: target.url });
    }
  } catch (err) {
    log.debug('panel-rpc list-remote-targets failed', { err: String(err) });
  }
  return pages;
}

async function listTargetsForFrameSearch(
  browser: PlaywrightBrowserAPI
): Promise<PlaywrightPageInfo[]> {
  try {
    return await listAllTargetsWithRemote(browser);
  } catch {
    return [];
  }
}

/** Explain a failed --tab attachment when the supplied target ID is actually a frame ID. */
export async function frameIdUsedAsTabError(
  browser: PlaywrightBrowserAPI,
  targetId: string,
  attachmentError: unknown
): Promise<string | null> {
  const message =
    attachmentError instanceof Error ? attachmentError.message : String(attachmentError);
  if (!message.includes('No target with given id found')) return null;

  for (const page of await listTargetsForFrameSearch(browser)) {
    try {
      const frames = await browser.withTab(page.targetId, async () => browser.getFrameTree());
      if (frames.some((frame) => frame.frameId === targetId)) {
        return `"${targetId}" is a frame ID, not a tab target ID. Use --tab=${page.targetId} --frame=${targetId}; run 'playwright-cli frames --tab=${page.targetId}' to list frame IDs.`;
      }
    } catch {
      // A tab may close while we inspect it; continue checking the remaining open tabs.
    }
  }
  return null;
}
