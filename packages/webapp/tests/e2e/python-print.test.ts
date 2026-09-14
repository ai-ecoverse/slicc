import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';
import { execInTerminal } from './two-instance-helpers.js';

const rootPkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../package.json'), 'utf8')
) as { dependencies: { pyodide: string } };
const PYODIDE_VERSION = rootPkg.dependencies.pyodide;

test.describe('python3 print smoke (browser ipk path)', () => {
  test('ipk-installs the pinned pyodide and prints 1 + 1', async ({ page }, testInfo) => {
    test.setTimeout(5 * 60_000);

    expect(PYODIDE_VERSION, 'root package.json must pin an exact pyodide version').toMatch(
      /^\d+\.\d+\.\d+/
    );

    await seedSkipSwReload(page);

    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    const missing = await execInTerminal(page, 'cd /workspace && python3 -c "print(1 + 1)"');
    expect(missing.exitCode, `missing-install stderr: ${missing.stderr}`).toBe(1);
    expect(missing.stderr).toContain(`ipk add pyodide@${PYODIDE_VERSION}`);

    const installCmd = `cd /workspace && ipk add pyodide@${PYODIDE_VERSION}`;
    const install = await execInTerminal(page, installCmd);
    const installReport =
      `command: ${installCmd}\n` +
      `exitCode: ${install.exitCode}\n` +
      `--- stdout ---\n${install.stdout}\n` +
      `--- stderr ---\n${install.stderr}`;
    await testInfo.attach('ipk-add-pyodide', { body: installReport, contentType: 'text/plain' });
    expect(install.exitCode, `ipk add stderr: ${install.stderr}`).toBe(0);

    const runCmd = 'cd /workspace && python3 -c "print(1 + 1)"';
    const run = await execInTerminal(page, runCmd);
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
