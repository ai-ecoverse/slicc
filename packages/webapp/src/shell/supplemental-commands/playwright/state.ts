/**
 * Shared state, flag parsing, and small utilities for the playwright-cli
 * command family.
 */

import { base64ToUint8 } from '@slicc/shared-ts';
import type { BrowserAPI } from '../../../cdp/index.js';
import { FsError, type VirtualFS } from '../../../fs/index.js';
import type { PlaywrightState } from './types.js';

export const PLAYWRIGHT_COMMAND_NAMES = ['playwright-cli', 'playwright', 'puppeteer'] as const;

const sharedStateByBrowser = new WeakMap<BrowserAPI, WeakMap<VirtualFS, PlaywrightState>>();

export function getSharedState(browser: BrowserAPI, fs: VirtualFS): PlaywrightState {
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
      networkCleanup: new Map(),
    };
    statesByFs.set(fs, state);
  }

  return state;
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

export async function getCurrentPageLocation(
  browser: BrowserAPI
): Promise<{ href: string; hostname: string; pathname: string }> {
  const raw = await browser.evaluate(
    `JSON.stringify({ href: location.href, hostname: location.hostname, pathname: location.pathname })`
  );
  return JSON.parse(raw as string) as { href: string; hostname: string; pathname: string };
}

/** Flags that accept a value when specified with a space (e.g. --tab <id> or --tab=<id>). */
const VALUE_FLAGS = new Set([
  'tab',
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
  'sameSite',
]);

/** Parse --key=value and --key value flags from args, returning remaining positional args + flags.
 *  Throws an error if a VALUE_FLAG is provided without a value. */
export function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (arg.startsWith('--')) {
      const flagName = arg.slice(2);
      // Check if this flag expects a value
      if (VALUE_FLAGS.has(flagName)) {
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[flagName] = args[++i];
        } else {
          throw new Error(`--${flagName} requires a value`);
        }
      } else {
        flags[flagName] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
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
