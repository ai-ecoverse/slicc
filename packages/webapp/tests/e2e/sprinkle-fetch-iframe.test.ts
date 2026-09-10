// packages/webapp/tests/e2e/sprinkle-fetch-iframe.test.ts
/**
 * Full-document sprinkle `slicc.fetch` must settle across the iframe
 * postMessage boundary (#2946). A native `Response` is not structured-
 * cloneable, so the parent has to post the SprinkleFetchResult wire shape
 * and the iframe rebuilds `Response`. This scenario drives a real srcdoc
 * iframe in the running app — a unit-only green is not enough.
 *
 *   Run: npm run test:e2e -- sprinkle-fetch-iframe
 */

import type { SprinkleManager } from '../../src/ui/sprinkle-manager.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const SPRINKLE_NAME = 'e2e-fetch-probe';
const SPRINKLE_PATH = `/shared/sprinkles/${SPRINKLE_NAME}/${SPRINKLE_NAME}.shtml`;
const SPRINKLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>e2e-fetch-probe</title>
  <link rel="icon" href="globe" />
</head>
<body>
  <h1>e2e-fetch-probe</h1>
</body>
</html>
`;

const SETTLE_MS = 12_000;

interface SprinkleManagerHarness {
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
  };
  refresh(): Promise<void>;
  open: SprinkleManager['open'];
  opened(): string[];
}

interface TimedCall {
  label: string;
  ms: number;
  status: 'OK' | 'HANG' | 'ERR';
  result?: unknown;
  error?: string;
}

declare global {
  interface Window {
    __slicc_sprinkleManager?: SprinkleManagerHarness;
  }
}

test.describe('sprinkle iframe slicc.fetch (#2946)', () => {
  test('full-document sprinkle fetch/exec/fetchToFile settle', async ({ page }) => {
    test.setTimeout(90_000);

    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // Warm the lucide script the full-doc iframe load event waits on, so the
    // 5s render timeout is not spent on a cold 477KB fetch.
    await page.evaluate(async () => {
      await fetch('/lucide-icons.js');
    });

    await page.evaluate(
      async ({ path, html, name }) => {
        const mgr = window.__slicc_sprinkleManager;
        if (!mgr) throw new Error('__slicc_sprinkleManager missing');
        await mgr.fs.mkdir('/shared/sprinkles/e2e-fetch-probe', { recursive: true });
        await mgr.fs.writeFile(path, html);
        await mgr.refresh();
        if (!mgr.opened().includes(name)) await mgr.open(name);
      },
      { path: SPRINKLE_PATH, html: SPRINKLE_HTML, name: SPRINKLE_NAME }
    );

    await page.waitForFunction(
      (name: string) => {
        const iframe = document.querySelector(
          `[data-sprinkle="${name}"] iframe`
        ) as HTMLIFrameElement | null;
        return Boolean(iframe?.contentWindow && 'slicc' in iframe.contentWindow);
      },
      SPRINKLE_NAME,
      { timeout: 20_000 }
    );

    const results = await page.evaluate(
      async ({ name, settleMs }) => {
        const iframe = document.querySelector(
          `[data-sprinkle="${name}"] iframe`
        ) as HTMLIFrameElement;
        const slicc = (
          iframe.contentWindow as Window & {
            slicc: {
              stat(path: string): Promise<{ type: string; size: number }>;
              exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
              fetch(url: string): Promise<Response>;
              fetchToFile(url: string, path: string): Promise<number>;
            };
          }
        ).slicc;
        const url = `${window.location.origin}/status`;

        async function timed(label: string, run: () => Promise<unknown>): Promise<TimedCall> {
          const t0 = performance.now();
          const hang = new Promise<{ _hang: true }>((resolve) =>
            setTimeout(() => resolve({ _hang: true }), settleMs)
          );
          try {
            const result = await Promise.race([run(), hang]);
            const ms = Math.round(performance.now() - t0);
            if (result && typeof result === 'object' && '_hang' in result) {
              return { label, ms, status: 'HANG' };
            }
            return { label, ms, status: 'OK', result };
          } catch (err) {
            return {
              label,
              ms: Math.round(performance.now() - t0),
              status: 'ERR',
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const exec = await timed('exec', () =>
          slicc.exec('echo ok').then((r) => ({
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
          }))
        );
        const fetch = await timed('fetch', async () => {
          const res = await slicc.fetch(url);
          return {
            ok: res.ok,
            status: res.status,
            ctor: res.constructor?.name,
            body: (await res.text()).slice(0, 200),
          };
        });
        const fetchToFile = await timed('fetchToFile', () =>
          slicc.fetchToFile(url, '/workspace/e2e-fetch-probe-body.txt')
        );
        return { exec, fetch, fetchToFile };
      },
      { name: SPRINKLE_NAME, settleMs: SETTLE_MS }
    );

    expect(results.exec.status, `exec: ${JSON.stringify(results.exec)}`).toBe('OK');
    expect(results.exec.result).toMatchObject({ stdout: 'ok\n', exitCode: 0 });

    expect(results.fetch.status, `fetch: ${JSON.stringify(results.fetch)}`).toBe('OK');
    expect(results.fetch.result).toMatchObject({
      ok: true,
      status: 200,
      ctor: 'Response',
    });
    expect(String((results.fetch.result as { body: string }).body)).not.toBe('');

    expect(results.fetchToFile.status, `fetchToFile: ${JSON.stringify(results.fetchToFile)}`).toBe(
      'OK'
    );
    expect(results.fetchToFile.result).toEqual(expect.any(Number));
    expect(results.fetchToFile.result as number).toBeGreaterThan(0);
  });
});
