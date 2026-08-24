// packages/webapp/tests/e2e/python-print.test.ts
/**
 * Real browser-float `python3 -c` smoke E2E.
 *
 * The Node-mode Vitest suite already boots Pyodide via
 * `file://…/node_modules/pyodide/` (`bash-tool.test.ts` —
 * `python3 -c "print(1 + 1)"` → `2`). That path never exercises the
 * standalone/browser contract: resolve an ipk-installed
 * `/workspace/node_modules/pyodide@<pin>`, fail fast with the pinned
 * `ipk add pyodide@…` guidance when it is missing, then load the four
 * runtime assets over realm VFS RPC.
 *
 * This scenario closes that gap against a real wrangler-served UI +
 * kernel worker:
 *
 *   1. Missing install → exit 1 with `ipk add pyodide@<root pin>`.
 *   2. `cd /workspace && ipk add pyodide@<pin>` through the fetch proxy.
 *   3. `python3 -c "print(1 + 1)"` prints `2`.
 *
 * The pin is read from the root `package.json` so a Renovate pyodide
 * bump cannot leave this fixture pointing at a stale version — the
 * same source of truth `PYODIDE_VERSION` uses at runtime.
 *
 *   Run: npm run test:e2e -- python-print
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const rootPkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../package.json'), 'utf8')
) as { dependencies: { pyodide: string } };
const PYODIDE_VERSION = rootPkg.dependencies.pyodide;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

declare global {
  interface Window {
    __slicc_terminal_view?: {
      executeCommandInTerminal(cmd: string): Promise<ExecResult>;
    };
  }
}

/** Run a single command through the worker shell via the published view. */
async function exec(page: import('@playwright/test').Page, cmd: string): Promise<ExecResult> {
  return page.evaluate(async (command: string) => {
    const view = window.__slicc_terminal_view;
    if (!view) throw new Error('terminal view not published yet');
    return view.executeCommandInTerminal(command);
  }, cmd);
}

test.describe('python3 print smoke (browser ipk path)', () => {
  test('ipk-installs the pinned pyodide and prints 1 + 1', async ({ page }, testInfo) => {
    // Cold `ipk add pyodide` pulls the full WASM tree through the fetch
    // proxy, then the realm boots Pyodide — well past the 30s default.
    test.setTimeout(5 * 60_000);

    expect(PYODIDE_VERSION, 'root package.json must pin an exact pyodide version').toMatch(
      /^\d+\.\d+\.\d+/
    );

    await seedSkipSwReload(page);
    // Thin-bridge launch params so `ipk add` reaches the node-server
    // fetch proxy (same reason speech-roundtrip / git-clone-live boot
    // via `gotoLeader`).
    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    await page.evaluate(() => {
      const dock = document.querySelector('slicc-dock') as
        | (HTMLElement & { selectItem?: (id: string) => void })
        | null;
      if (!dock?.selectItem) throw new Error('<slicc-dock>.selectItem(id) unavailable');
      dock.selectItem('term');
    });
    await page.waitForFunction(() => window.__slicc_terminal_view != null, null, {
      timeout: 30_000,
    });

    // 1. Fresh VFS: browser float refuses to boot without the pinned
    //    install and surfaces the canonical remediation. `cd /workspace`
    //    so the nearest-`node_modules` walk matches where `ipk add` lands
    //    (terminal boots at `/`; see speech-roundtrip).
    const missing = await exec(page, 'cd /workspace && python3 -c "print(1 + 1)"');
    expect(missing.exitCode, `missing-install stderr: ${missing.stderr}`).toBe(1);
    expect(missing.stderr).toContain(`ipk add pyodide@${PYODIDE_VERSION}`);

    // 2. Install the exact pin the running build expects.
    const installCmd = `cd /workspace && ipk add pyodide@${PYODIDE_VERSION}`;
    const install = await exec(page, installCmd);
    const installReport =
      `command: ${installCmd}\n` +
      `exitCode: ${install.exitCode}\n` +
      `--- stdout ---\n${install.stdout}\n` +
      `--- stderr ---\n${install.stderr}`;
    await testInfo.attach('ipk-add-pyodide', { body: installReport, contentType: 'text/plain' });
    expect(install.exitCode, `ipk add stderr: ${install.stderr}`).toBe(0);

    // 3. Smoke: real Pyodide eval through the VFS-bytes loader.
    const runCmd = 'cd /workspace && python3 -c "print(1 + 1)"';
    const run = await exec(page, runCmd);
    const runReport =
      `command: ${runCmd}\n` +
      `exitCode: ${run.exitCode}\n` +
      `--- stdout ---\n${run.stdout}\n` +
      `--- stderr ---\n${run.stderr}`;
    await testInfo.attach('python3-print', { body: runReport, contentType: 'text/plain' });
    expect(run.exitCode, `python3 stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout.trim()).toBe('2');
  });
});
