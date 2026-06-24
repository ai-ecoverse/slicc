/**
 * Storage state subcommands: state-save and state-load.
 *
 * Serializes/restores the full browser storage state — cookies + localStorage —
 * to/from a JSON file on the VFS. Uses Playwright's storage state format so
 * state files are interoperable with Playwright's storageState option.
 *
 * Format:
 *   { cookies: [...], origins: [{ origin: string, localStorage: [{name, value}] }] }
 *
 * Note: sessionStorage is intentionally excluded (matches Playwright's format).
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const stateSaveHandler: PlaywrightHandler = async ({ browser, fs, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }

  const savePath = flags['filename'] ?? positional[0] ?? '/.playwright/storage-state.json';

  let cookies: unknown[] = [];
  let localStorageItems: Array<{ name: string; value: string }> = [];
  let origin = '';

  // Get cookies (context-level, works outside of a tab session)
  const cookieResult = await browser.sendCDP('Network.getCookies');
  cookies = (cookieResult as { cookies: unknown[] }).cookies ?? [];

  // Get origin and localStorage (requires the tab context)
  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();

    const urlResult = await transport.send(
      'Runtime.evaluate',
      { expression: 'location.origin', returnByValue: true },
      sessionId
    );
    origin = (urlResult as { result: { value: string } }).result.value ?? '';

    const lsResult = await transport.send(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify(Object.entries(localStorage).map(([name,value])=>({name,value})))',
        returnByValue: true,
      },
      sessionId
    );
    const raw = (lsResult as { result: { value: string } }).result.value ?? '[]';
    localStorageItems = JSON.parse(raw) as Array<{ name: string; value: string }>;
  });

  const storageState = {
    cookies,
    origins: origin ? [{ origin, localStorage: localStorageItems }] : [],
  };

  const json = JSON.stringify(storageState, null, 2);
  await fs.writeFile(savePath, json);
  return { stdout: `Saved storage state to ${savePath}\n`, stderr: '', exitCode: 0 };
};

export const stateLoadHandler: PlaywrightHandler = async ({ browser, fs, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'state-load requires a filename\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }

  const loadPath = positional[0];

  let storageState: {
    cookies?: unknown[];
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };

  try {
    const content = await fs.readTextFile(loadPath);
    storageState = JSON.parse(content) as typeof storageState;
  } catch {
    return {
      stdout: '',
      stderr: `Failed to read storage state from ${loadPath}\n`,
      exitCode: 1,
    };
  }

  // Restore cookies (context-level)
  if (storageState.cookies?.length) {
    await browser.sendCDP('Network.setCookies', { cookies: storageState.cookies });
  }

  // Restore localStorage (requires tab context)
  if (storageState.origins?.length) {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      for (const { localStorage: items } of storageState.origins!) {
        const script = `(function() {
  var items = ${JSON.stringify(items)};
  for (var i = 0; i < items.length; i++) {
    localStorage.setItem(items[i].name, items[i].value);
  }
})()`;
        await transport.send(
          'Runtime.evaluate',
          { expression: script, returnByValue: true },
          sessionId
        );
      }
    });
  }

  return { stdout: `Loaded storage state from ${loadPath}\n`, stderr: '', exitCode: 0 };
};
