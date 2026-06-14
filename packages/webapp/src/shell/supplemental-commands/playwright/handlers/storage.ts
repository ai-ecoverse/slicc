/**
 * Web Storage subcommands (via evaluate): localstorage-* and sessionstorage-*.
 *
 * The local/session variants are structurally identical apart from the
 * Storage object they target, so both families are produced from one factory.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

/** `cmdPrefix` is the user-facing command name (e.g. `localstorage`); `storageObj`
 *  is both the in-page Storage global and the human-readable label. */
function createStorageHandlers(
  cmdPrefix: string,
  storageObj: 'localStorage' | 'sessionStorage'
): {
  list: PlaywrightHandler;
  get: PlaywrightHandler;
  set: PlaywrightHandler;
  del: PlaywrightHandler;
  clear: PlaywrightHandler;
} {
  const list: PlaywrightHandler = async ({ browser, flags }) => {
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    const output = await browser.withTab(tab.targetId, async () => {
      const raw = (await browser.evaluate(
        `JSON.stringify(Object.entries(${storageObj}))`
      )) as string;
      const entries = JSON.parse(raw) as [string, string][];
      if (entries.length === 0) {
        return `No ${storageObj} entries`;
      }
      const lines = entries.map(([k, v]) => `${k}=${v}`);
      return lines.join('\n');
    });
    return { stdout: output + '\n', stderr: '', exitCode: 0 };
  };

  const get: PlaywrightHandler = async ({ browser, positional, flags }) => {
    if (positional.length === 0) {
      return { stdout: '', stderr: `${cmdPrefix}-get requires a key\n`, exitCode: 1 };
    }
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    const output = await browser.withTab(tab.targetId, async () => {
      const val = await browser.evaluate(`${storageObj}.getItem(${JSON.stringify(positional[0])})`);
      if (val === null) {
        throw new Error(`Key "${positional[0]}" not found in ${storageObj}`);
      }
      return val;
    });
    return { stdout: output + '\n', stderr: '', exitCode: 0 };
  };

  const set: PlaywrightHandler = async ({ browser, positional, flags }) => {
    if (positional.length < 2) {
      return {
        stdout: '',
        stderr: `${cmdPrefix}-set requires <key> <value>\n`,
        exitCode: 1,
      };
    }
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    await browser.withTab(tab.targetId, async () => {
      await browser.evaluate(
        `${storageObj}.setItem(${JSON.stringify(positional[0])}, ${JSON.stringify(positional.slice(1).join(' '))})`
      );
    });
    return { stdout: `${storageObj} "${positional[0]}" set\n`, stderr: '', exitCode: 0 };
  };

  const del: PlaywrightHandler = async ({ browser, positional, flags }) => {
    if (positional.length === 0) {
      return { stdout: '', stderr: `${cmdPrefix}-delete requires a key\n`, exitCode: 1 };
    }
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    await browser.withTab(tab.targetId, async () => {
      await browser.evaluate(`${storageObj}.removeItem(${JSON.stringify(positional[0])})`);
    });
    return { stdout: `${storageObj} "${positional[0]}" deleted\n`, stderr: '', exitCode: 0 };
  };

  const clear: PlaywrightHandler = async ({ browser, flags }) => {
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    await browser.withTab(tab.targetId, async () => {
      await browser.evaluate(`${storageObj}.clear()`);
    });
    return { stdout: `${storageObj} cleared\n`, stderr: '', exitCode: 0 };
  };

  return { list, get, set, del, clear };
}

export const localStorageHandlers = createStorageHandlers('localstorage', 'localStorage');
export const sessionStorageHandlers = createStorageHandlers('sessionstorage', 'sessionStorage');
