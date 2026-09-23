import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const stateSaveHandler: PlaywrightHandler = async ({
  browser,
  fs,
  positional,
  flags,
  sessionRoot,
  onTab,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }

  const savePath = flags['filename'] ?? positional[0] ?? `${sessionRoot}/storage-state.json`;

  let cookies: unknown[] = [];
  let localStorageItems: Array<{ name: string; value: string }> = [];
  let origin = '';

  await onTab(tab.targetId, async (page) => {
    const cookieResult = await page.send('Network.getCookies');
    cookies = (cookieResult as { cookies: unknown[] }).cookies ?? [];

    const { sessionId, transport } = page;
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

export const stateLoadHandler: PlaywrightHandler = async ({
  browser,
  fs,
  positional,
  flags,
  onTab,
}) => {
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

  let skippedOrigins: Array<{ origin: string }> = [];
  if (storageState.cookies?.length || storageState.origins?.length) {
    await onTab(tab.targetId, async (page) => {
      if (storageState.cookies?.length) {
        await page.send('Network.setCookies', { cookies: storageState.cookies });
      }
      if (!storageState.origins?.length) return;

      const { sessionId, transport } = page;
      const originResult = await transport.send(
        'Runtime.evaluate',
        { expression: 'location.origin', returnByValue: true },
        sessionId
      );
      const currentOrigin = (originResult as { result: { value: string } }).result.value ?? '';

      const matchingOrigins = storageState.origins!.filter((o) => o.origin === currentOrigin);
      skippedOrigins = storageState.origins!.filter((o) => o.origin !== currentOrigin);

      for (const { localStorage: items } of matchingOrigins) {
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

  let stderr = '';
  if (skippedOrigins.length > 0) {
    const names = skippedOrigins.map((o) => o.origin).join(', ');
    stderr = `Skipped localStorage for non-matching origins: ${names}\n`;
  }
  return { stdout: `Loaded storage state from ${loadPath}\n`, stderr, exitCode: 0 };
};
