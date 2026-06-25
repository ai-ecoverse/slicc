// packages/webapp/tests/e2e/speech-roundtrip.test.ts
/**
 * Real `say -o` WAV-output E2E. Drives the WC shell's worker terminal
 * through the page-side `RemoteTerminalView` (published on
 * `globalThis.__slicc_terminal_view` by `mountWorkbenchTerminal`) — the
 * same programmatic-dispatch seam the chat panel's "run in terminal"
 * affordance uses. Real Kokoro synthesizes the WAV; nothing is stubbed.
 *
 * Why no whisper / `hear -i` round-trip: a single ~190 MB OPFS write
 * (whisper's decoder_model.onnx) reliably trips a `@zenfs/dom` +
 * `kerium` interaction bug in headless Chromium ("Cannot set property
 * message of ... which has only a getter"), unrelated to `say -o`. We
 * exercise the new flag end-to-end (worker → page panel-RPC →
 * synthesize-to-wav handler → kokoro stream → wav-encode → bytes back →
 * VFS write) and validate the produced WAV's header + size. The unit
 * tests in `tests/speech/wav-encode.test.ts` cover header-byte details.
 *
 * Gated behind `RUN_REAL_SPEECH_E2E=1` because the Kokoro-82M weights
 * + onnxruntime wasm runtime are ~100 MB through the node-server fetch
 * proxy on a cold OPFS — opt-in for local runs (CI enables it on the
 * `speech-e2e` job).
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

test.describe('say -o WAV output (real kokoro)', () => {
  test.skip(
    !RUN,
    'set RUN_REAL_SPEECH_E2E=1 to opt in (downloads ~100 MB of kokoro weights on a cold OPFS)'
  );

  test('writes a valid kokoro-synthesized WAV', async ({ page }) => {
    // Cold-OPFS weight download dwarfs the 30s default; bound the whole
    // run at 10 minutes. Per-call exec budgets are bounded by the
    // panel-RPC ceiling inside `say` (5 min).
    test.setTimeout(10 * 60_000);

    const diagnostics = attachBrowserDiagnostics(page);

    // Force the WASM/q8 kokoro path: headless Chromium exposes
    // `navigator.gpu` (no `--enable-unsafe-webgpu` needed), which makes
    // `kokoro-engine.ts`'s `wantGpu` selector pick `dtype: 'fp32'` and
    // load the 326 MB `onnx/model.onnx`. We pre-stage the 92 MB
    // `onnx/model_quantized.onnx` instead, so the engine must take the
    // q8 branch. Deleting the property before any app code runs is the
    // only way to flip `'gpu' in navigator` to `false`.
    await page.addInitScript(() => {
      try {
        delete (Navigator.prototype as unknown as { gpu?: unknown }).gpu;
        delete (navigator as unknown as { gpu?: unknown }).gpu;
      } catch {
        /* best-effort — engine still falls through on WASM if alloc fails */
      }
    });

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

    // 1. Pre-stage the kokoro runtime + the specific weight files the
    //    `dtype: 'q8'` path in `kokoro-engine.ts` resolves to (config +
    //    tokenizer + `model_quantized.onnx`, ~92 MB total). We avoid
    //    `hf download <repo>` with no file list (would pull every onnx
    //    variant, ~1.4 GB) and we avoid the whisper repo entirely (its
    //    188 MB decoder write reliably trips the kerium DOMException
    //    bug; that failure is unrelated to `say -o`).
    //
    //    `cd /workspace` first: `ipk add` extracts into `<cwd>/node_modules`,
    //    but `transformers-env.ts` reads ort bytes from the fixed
    //    `ORT_DIST_VFS_PATH = '/workspace/node_modules/onnxruntime-web/dist/'`.
    //    The workbench terminal boots at cwd `/` (`mountWorkbenchTerminal`
    //    in `wc-live.ts`), so without the cd the install lands at
    //    `/node_modules/...` and `buildOrtWasmPathsFromVfs` surfaces the
    //    canonical "onnxruntime-web is not installed" guidance.
    const pkgs = await exec(
      page,
      'cd /workspace && ipk add @huggingface/transformers onnxruntime-web kokoro-js'
    );
    expect(pkgs.exitCode, `ipk add stderr: ${pkgs.stderr}`).toBe(0);
    const kokoroDl = await exec(
      page,
      'hf download onnx-community/Kokoro-82M-v1.0-ONNX ' +
        'config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx'
    );
    expect(kokoroDl.exitCode, `hf kokoro stderr: ${kokoroDl.stderr}`).toBe(0);

    // 2. `say --warmup` is fire-and-forget on the page; the kokoro load
    //    inside `stageThenLoadKokoro` catches the (expected, whisper-
    //    missing) staging failure and falls through to `getKokoro()`,
    //    which loads from the pre-staged VFS files. Poll `--status`.
    const warmup = await exec(page, 'say --warmup');
    expect(warmup.exitCode, `warmup stderr: ${warmup.stderr}`).toBe(0);
    await waitForReady(page, 'say --status', /voice engine: ready/, 5 * 60_000, diagnostics);

    // 3. Synthesize to the VFS. `-l` is required by the speak path; the
    //    voice .bin (~512 KB) is fetched by kokoro-js directly from HF
    //    on first use (cached in `CacheStorage`, not OPFS — sidesteps
    //    the kerium bug).
    const outPath = '/tmp/say-out.wav';
    const synth = await exec(page, `say -l en-US -o ${outPath} "hello world"`);
    expect(
      synth.exitCode,
      `synth stderr: ${synth.stderr}\n--- diag ---\n${diagTail(diagnostics)}`
    ).toBe(0);
    expect(synth.stdout).toMatch(/wrote \d+ KB to \/tmp\/say-out\.wav/);

    // 4. File should be a non-trivial WAV — guards against silent
    //    truncation in the worker→page→worker hop.
    const ls = await exec(page, `wc -c ${outPath}`);
    expect(ls.exitCode, `wc stderr: ${ls.stderr}`).toBe(0);
    const sizeMatch = ls.stdout.trim().match(/^(\d+)/);
    expect(sizeMatch, `wc stdout: ${ls.stdout}`).not.toBeNull();
    expect(Number(sizeMatch![1])).toBeGreaterThan(8_000);

    // 5. RIFF magic confirms `wav-encode.ts` wrote a real WAV header,
    //    not just any bytes (the encoder unit tests cover full header
    //    field layout). `head -c 4` returns the first 4 bytes as ASCII;
    //    'RIFF' is the only legal prefix.
    const magic = await exec(page, `head -c 4 ${outPath}`);
    expect(magic.exitCode, `head stderr: ${magic.stderr}`).toBe(0);
    expect(magic.stdout).toBe('RIFF');
  });
});
