// packages/webapp/tests/e2e/git-clone-live.test.ts
/**
 * REAL, live-network `git clone` E2E. Drives the WC shell's worker terminal
 * through the page-side `RemoteTerminalView` (published on
 * `globalThis.__slicc_terminal_view` by `mountWorkbenchTerminal`) — the same
 * programmatic-dispatch seam `speech-roundtrip.test.ts` uses — and runs
 * `git clone https://github.com/ai-ecoverse/skills.git` against the public
 * GitHub repo, unauthenticated, through the node-server fetch proxy.
 *
 * Purpose is a REGRESSION GUARD on the clone hot path: after the live clone of
 * ai-ecoverse/skills, it asserts a FULL successful checkout — exit 0, a nonzero
 * "Checked out N files." count, a representative DEEP regular file, and a
 * representative SYMLINK entry (mode 120000) — so a broken checkout (e.g. the
 * OPFS parallel-checkout ENOENT race, which the earlier `expandGitError` unwrap
 * in `src/git/commands/shared.ts` surfaces as a real error) fails loudly with
 * the full captured output attached, not an opaque wrapper sentence.
 *
 * NOT gated: `git clone` is a hot regression area, so this test runs in CI as
 * part of the standard `npm run test:e2e` pass. It hits the real network
 * (unauthenticated clone of a public repo), so it is made robust to transient
 * flake via the e2e config's CI retries and a generous per-test timeout, and
 * asserts on the substantive outcome (a full successful checkout), never
 * incidental timing.
 *
 *   Run: npm run test:e2e -- git-clone-live
 */

import { expect, test } from '@playwright/test';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const CLONE_URL = 'https://github.com/ai-ecoverse/skills.git';

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

test.describe('live git clone (real network)', () => {
  test('clones ai-ecoverse/skills and surfaces the real result', async ({ page }, testInfo) => {
    // A real, unauthenticated clone over the fetch proxy dwarfs the 30s
    // default; give the whole run 5 minutes.
    test.setTimeout(5 * 60_000);

    await seedSkipSwReload(page);
    // Boot with the thin-bridge launch params so the virtual git CLI's HTTP
    // (isomorphic-git → gitHttp → proxied-fetch) reaches the node-server
    // `/api/fetch-proxy` and real network works.
    await gotoLeader(page);
    await waitForSW(page);

    // Cone welcome message is the same readiness signal the other scenarios
    // wait on — it renders only after the kernel-worker cone bootstrap
    // completes and the OffscreenClient is wired.
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // Activate the term surface via the shell's documented entry point; this
    // opens the workbench AND fires the lazy mount that publishes
    // `__slicc_terminal_view`.
    await page.evaluate(() => {
      const shell = document.querySelector('slicc-shell') as
        | (HTMLElement & { select?: (id: string) => void })
        | null;
      if (!shell?.select) throw new Error('<slicc-shell>.select(id) unavailable');
      shell.select('term');
    });
    await page.waitForFunction(() => window.__slicc_terminal_view != null, null, {
      timeout: 30_000,
    });

    // Run the real clone into a clean target dir.
    const targetDir = '/workspace/skills-live-clone';
    await exec(page, `rm -rf ${targetDir}`);
    const clone = await exec(page, `git clone ${CLONE_URL} ${targetDir}`);

    // Attach the FULL captured output to the report so the failure message is
    // actionable — the real inner cause, not an opaque wrapper.
    const report =
      `command: git clone ${CLONE_URL} ${targetDir}\n` +
      `exitCode: ${clone.exitCode}\n` +
      `--- stdout ---\n${clone.stdout}\n` +
      `--- stderr ---\n${clone.stderr}`;
    await testInfo.attach('git-clone-output', { body: report, contentType: 'text/plain' });
    // Also to stdout so `--reporter=list` surfaces it inline.
    console.log('\n=== live git clone result ===\n' + report + '\n=============================\n');

    // Assert a FULL successful checkout. Until the OPFS parallel-checkout race
    // fix lands this (correctly) goes red — that is the intended signal, and the
    // full captured output is attached above so the failure is diagnosable.
    expect(clone.exitCode, `git clone did not exit 0 — full output:\n${report}`).toBe(0);

    // The checkout must report a nonzero file count, not an empty tree.
    const checkedOut = clone.stdout.match(/Checked out (\d+) files\./);
    expect(checkedOut, `expected "Checked out N files." — full output:\n${report}`).not.toBeNull();
    expect(Number(checkedOut?.[1] ?? '0'), 'checked-out file count').toBeGreaterThan(0);

    // A representative DEEP regular file must exist on the VFS. Verified to
    // exist in ai-ecoverse/skills@main (skills/suno/references/endpoints.md).
    const deepFile = `${targetDir}/skills/suno/references/endpoints.md`;
    const deep = await exec(page, `[ -f ${deepFile} ] && echo FILE_OK`);
    expect(deep.exitCode, `[ -f ${deepFile} ] failed: ${JSON.stringify(deep)}`).toBe(0);
    expect(deep.stdout).toContain('FILE_OK');

    // A representative SYMLINK entry (git mode 120000) must be checked out AS a
    // symlink, not materialized as a regular file. Verified to be a mode-120000
    // entry in ai-ecoverse/skills@main (tiles/advanced/skills/slack).
    const symlink = `${targetDir}/tiles/advanced/skills/slack`;
    const link = await exec(page, `[ -L ${symlink} ] && readlink ${symlink}`);
    expect(link.exitCode, `[ -L ${symlink} ] failed: ${JSON.stringify(link)}`).toBe(0);
    expect(link.stdout.trim(), `readlink ${symlink} target`).not.toBe('');
  });
});
