// packages/webapp/tests/e2e/speech-roundtrip.test.ts
/**
 * Real speech round-trip E2E. Drives the WC shell's worker terminal
 * through the page-side `RemoteTerminalView` (published on
 * `globalThis.__slicc_terminal_view` by `mountWorkbenchTerminal`) — the
 * same programmatic-dispatch seam the chat panel's "run in terminal"
 * affordance uses. Real Kokoro synthesizes the WAV, real Whisper
 * transcribes it back; nothing is stubbed.
 *
 * Gated behind `RUN_REAL_SPEECH_E2E=1` because `say --warmup` triggers
 * the on-demand staging of `onnxruntime-web` (npm) plus the
 * whisper-tiny + Kokoro-82M weight repos (HuggingFace), totaling
 * ~300-400 MB through the node-server fetch proxy on a cold OPFS — way
 * beyond CI's per-test budget. OPFS persists per-origin so a second
 * local run is fast.
 *
 * No fake-LLM seeding: this test never submits a chat turn, so the
 * cone bootstrap is sufficient. We open the workbench via
 * `<slicc-shell>.select('term')` (the canonical activation entry point,
 * same call path the dock click takes) and wait for the view seam.
 */

import { expect, test } from '@playwright/test';
import { seedSkipSwReload, waitForSW } from './helpers.js';

const RUN = process.env['RUN_REAL_SPEECH_E2E'] === '1';

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

/**
 * Capture browser console + page errors + failed requests so the actual
 * cause of a kokoro/whisper warmup failure (load crash, ort wasm fault,
 * fetch-proxy refusal, …) surfaces in the Playwright report instead of
 * being swallowed behind the worker→page bridge that only returns `failed`.
 */
function attachBrowserDiagnostics(page: import('@playwright/test').Page): { entries: string[] } {
  const entries: string[] = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (
      type === 'error' ||
      type === 'warning' ||
      /(speech|kokoro|whisper|ort|onnx|hf|ipk|panel-rpc)/i.test(msg.text())
    ) {
      entries.push(`[console.${type}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    entries.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`);
  });
  page.on('requestfailed', (req) => {
    entries.push(
      `[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? '?'}`
    );
  });
  return { entries };
}

function diagTail(diagnostics: { entries: string[] }): string {
  const tail = diagnostics.entries.slice(-50).join('\n');
  return tail || '(no browser diagnostics captured)';
}

/** Poll a status command until its stdout matches `readyMarker`. */
async function waitForReady(
  page: import('@playwright/test').Page,
  statusCmd: string,
  readyMarker: RegExp,
  timeoutMs: number,
  diagnostics: { entries: string[] }
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const r = await exec(page, statusCmd);
    last = r.stdout + r.stderr;
    if (readyMarker.test(r.stdout)) return;
    if (/failed/i.test(r.stdout)) {
      throw new Error(
        `${statusCmd} reported failure: ${r.stdout}` +
          `\n--- browser diagnostics (last 50) ---\n${diagTail(diagnostics)}`
      );
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(
    `${statusCmd} did not reach ready within ${timeoutMs}ms; last: ${last}` +
      `\n--- browser diagnostics (last 50) ---\n${diagTail(diagnostics)}`
  );
}

test.describe('speech round-trip (real models)', () => {
  test.skip(
    !RUN,
    'set RUN_REAL_SPEECH_E2E=1 to opt in (downloads ~400 MB of model weights on a cold OPFS)'
  );

  test('say -o WAV → hear -i transcribes back', async ({ page }) => {
    // Cold-OPFS weight download dwarfs the 30s default — give the whole
    // round trip 15 minutes. Per-call exec budgets are bounded by the
    // panel-RPC ceilings inside say/hear (5min each).
    test.setTimeout(15 * 60_000);

    const diagnostics = attachBrowserDiagnostics(page);

    await seedSkipSwReload(page);
    await page.goto('/');
    await waitForSW(page);

    // Same readiness signal `reference-scenario.test.ts` waits on — the
    // cone's welcome message renders only after the kernel-worker cone
    // bootstrap has completed and the OffscreenClient is wired.
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // Activate the term surface via the shell's documented entry point;
    // this opens the workbench AND fires the lazy mount that publishes
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

    // 1. Kick the kokoro download (`speak-warmup` returns immediately
    //    with the current state; the engine load runs in the background).
    const warmup = await exec(page, 'say --warmup');
    expect(warmup.exitCode, `warmup stderr: ${warmup.stderr}`).toBe(0);

    // 2. Wait for ready. `formatStatus` emits "voice engine: ready" on
    //    success and "voice engine: failed" on terminal failure.
    await waitForReady(page, 'say --status', /voice engine: ready/, 10 * 60_000, diagnostics);
    await waitForReady(page, 'hear --status', /enhanced engine: ready/, 5 * 60_000, diagnostics);

    // 3. Synthesize to the VFS. `-l` is required by the speak path.
    const outPath = '/tmp/roundtrip.wav';
    const synth = await exec(page, `say -l en-US -o ${outPath} "hello world"`);
    expect(synth.exitCode, `synth stderr: ${synth.stderr}`).toBe(0);
    expect(synth.stdout).toMatch(/wrote \d+ KB to \/tmp\/roundtrip\.wav/);

    // 4. File should be a non-trivial WAV — guards against silent
    //    truncation in the worker→page→worker hop.
    const ls = await exec(page, `wc -c ${outPath}`);
    expect(ls.exitCode, `wc stderr: ${ls.stderr}`).toBe(0);
    const sizeMatch = ls.stdout.trim().match(/^(\d+)/);
    expect(sizeMatch, `wc stdout: ${ls.stdout}`).not.toBeNull();
    expect(Number(sizeMatch![1])).toBeGreaterThan(8_000);

    // 5. Transcribe the WAV with whisper.
    const heard = await exec(page, `hear -i ${outPath}`);
    expect(heard.exitCode, `hear stderr: ${heard.stderr}`).toBe(0);
    // Whisper outputs lower/upper/punct variants; assert a stable token.
    expect(heard.stdout.toLowerCase()).toContain('hello');
  });
});
