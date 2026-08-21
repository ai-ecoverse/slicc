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
 * proxy on a cold OPFS — opt-in for local runs (the CI `e2e` job enables
 * it when the `speech` path filter matches).
 */

import { expect, test } from '@playwright/test';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

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
      // `espeak`/`phonem` were missing, which is why a run that fails INSIDE
      // the phonemizer showed nothing but WebGL noise. Anything the speech
      // stack says on the way up is worth keeping.
      /(speech|kokoro|whisper|espeak|phonem|ort|onnx|hf|ipk|panel-rpc)/i.test(msg.text())
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
  // 50 was too few: headless Chromium emits a burst of WebGL driver warnings
  // that pushed every speech line out of the window, so a failure deep in the
  // engine reported only GPU noise.
  const tail = diagnostics.entries.slice(-120).join('\n');
  return tail || '(no browser diagnostics captured)';
}

/**
 * Origin storage usage vs quota, for the failure message.
 *
 * This run writes ~92 MB of kokoro weights into OPFS and lets transformers.js
 * cache fetched assets in CacheStorage — both billed against one per-origin
 * quota that Chromium derives from FREE DISK on the volume holding the browser
 * profile. When that quota is short, the failure surfaces far from the cause:
 * the model still loads (`voice engine: ready`), then synthesis reports an
 * empty voice/language list, with only a `QuotaExceededError` console warning
 * to connect the two. Print the numbers so a red run says which it was instead
 * of leaving the next reader to infer it.
 */
async function storageReport(page: import('@playwright/test').Page): Promise<string> {
  try {
    const est = await page.evaluate(async () => {
      const e = await navigator.storage?.estimate?.();
      return e ? { usage: e.usage ?? null, quota: e.quota ?? null } : null;
    });
    if (!est) return 'storage: navigator.storage.estimate() unavailable';
    const mb = (n: number | null) => (n == null ? '?' : `${(n / 1024 / 1024).toFixed(1)} MB`);
    const headroom = est.usage != null && est.quota != null ? mb(est.quota - est.usage) : 'unknown';
    return `storage: usage ${mb(est.usage)} / quota ${mb(est.quota)} (headroom ${headroom})`;
  } catch (err) {
    return `storage: estimate failed — ${err instanceof Error ? err.message : String(err)}`;
  }
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
          `\n${await storageReport(page)}` +
          `\n--- browser diagnostics (last 50) ---\n${diagTail(diagnostics)}`
      );
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(
    `${statusCmd} did not reach ready within ${timeoutMs}ms; last: ${last}` +
      `\n${await storageReport(page)}` +
      `\n--- browser diagnostics (last 50) ---\n${diagTail(diagnostics)}`
  );
}

test.describe('say -o WAV output (real kokoro)', () => {
  // No retries here, against the config's CI-wide `retries: 2`. This spec takes
  // ~7 minutes, so a deterministic failure spent 21 minutes pretending to be
  // flaky — and "green on attempt 3" is exactly how a load-sensitive race hides.
  // The engine race this spec exists to catch (see the espeak readiness note in
  // `vite-plugins/fix-kokoro-espeak-readiness.ts`) is one of those. Fail once,
  // fast, and honestly. Other e2e specs keep the CI retries.
  // One retry, where this spec used to take none.
  //
  // The intent behind `retries: 0` was to fail fast and honestly, and that
  // still holds for the kokoro work itself. What it did not anticipate is that
  // `bootLeader`'s terminal mount fails on the FIRST browser context and
  // recovers on a fresh one — repo-wide, not something about speech: on
  // unrelated, fully green PRs `git-clone-live` fails its first attempt on the
  // identical `__slicc_terminal_view` wait and passes on retry. Raising the
  // wait does not help (90s fails the same way), because the mount does not
  // eventually succeed — it needs the new context.
  //
  // Without a retry this spec converts that shared flake into a red run, but
  // only on the PRs that happen to match the `speech` change-filter (which
  // includes `wc-live.ts`), so the failure lands on whoever touched an
  // unrelated file. One retry puts it on equal footing with every other spec.
  test.describe.configure({ retries: 1 });

  test.skip(
    !RUN,
    'set RUN_REAL_SPEECH_E2E=1 to opt in (downloads ~100 MB of kokoro weights on a cold OPFS)'
  );

  test('writes a valid kokoro-synthesized WAV', async ({ page }) => {
    // Cold-OPFS weight download dwarfs the 30s default. 10 minutes was too
    // tight once the download could be retried: observed CI runs land between
    // 9 and 15 minutes, so the cap was itself producing failures
    // (`Test timeout of 600000ms exceeded`) that looked like product bugs.
    // The staging recovery below can add one page reboot + one more full
    // download pass (~6 min on a slow runner), so 20 was itself too tight.
    // Per-call exec budgets are still bounded by the panel-RPC ceiling inside
    // `say` (5 min).
    test.setTimeout(25 * 60_000);

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
      // The espeak dictionaries are decompressed by an async IIFE with no
      // `catch`, so if it throws the data silently never lands and the only
      // downstream symptom is a phonemizer with zero voices. An unhandled
      // rejection is not a `pageerror`, so Playwright never sees it — park
      // them somewhere the failure path can read.
      const rejections: string[] = [];
      (window as unknown as { __sliccRejections: string[] }).__sliccRejections = rejections;
      window.addEventListener('unhandledrejection', (event) => {
        const reason = (event as PromiseRejectionEvent).reason;
        rejections.push(
          reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
        );
      });
    });

    await seedSkipSwReload(page);
    // Boot with the thin-bridge launch params: `ipk add` / `hf download` below
    // pull weights through the node-server fetch proxy, which the webapp only
    // reaches cross-origin when `proxied-fetch` is pointed at the bridge origin.
    //
    // Kept as a closure so the staging recovery below re-boots EXACTLY the way
    // the test boots — init scripts (webgpu delete, rejection log) re-apply on
    // every navigation, and VFS state (ipk installs, downloaded weights)
    // persists in OPFS/IndexedDB across the reload.
    //
    // `firstRun` gates the welcome assertion, which is a COLD-boot-only
    // signal: `detectWelcomeFirstRun` suppresses the lick once the cone's
    // history already holds one (and returns `isFirstRun: false` outright
    // when the marker read throws — which is exactly what a wedged OPFS
    // session does). The staging recovery below re-boots a page that has
    // already been greeted, so asserting it there fails on a thread whose
    // only text is the "New messages" follow chip. The terminal-view wait
    // is the signal that holds for both boots: `mountWorkbenchTerminal`
    // publishes it only once the kernel session is live.
    const bootLeader = async ({ firstRun = true }: { firstRun?: boolean } = {}) => {
      await gotoLeader(page);
      await waitForSW(page);

      // Same readiness signal `reference-scenario.test.ts` waits on — the
      // cone's welcome message renders only after the kernel-worker cone
      // bootstrap has completed and the OffscreenClient is wired.
      await page.waitForSelector('slicc-input-card');
      if (firstRun) {
        await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
          timeout: 20_000,
        });
      }

      // Activate the term surface via the dock rail's documented entry point;
      // `selectItem` fires `slicc-dock-select`, which `wc-sprinkles.ts` routes
      // into the dock-tree, opening the workbench AND firing the lazy mount
      // that publishes `__slicc_terminal_view`.
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
    };
    await bootLeader();

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
    //
    //    `espeak-ng` is staged here for the same reason ort is: SLICC
    //    phonemizes **English too** through espeak-ng (`kokoro-engine.ts`:
    //    en/es/fr/it/hi/pt), reading the wasm from the fixed
    //    `ESPEAK_DIST_VFS_PATH = '/workspace/node_modules/espeak-ng/dist/'`.
    //    Warmup's `ensureSpeechAssets` would normally stage it, but this test
    //    deliberately runs without the whisper repo, so that staging throws
    //    before it reaches espeak and the run falls through to `getKokoro()`.
    //    Without an explicit install the model loads and every voice lists
    //    fine, then synthesis fails on an espeak with zero languages:
    //    `Invalid language identifier: "en-us". Should be one of: .`
    const pkgs = await exec(
      page,
      'cd /workspace && ipk add @huggingface/transformers onnxruntime-web kokoro-js espeak-ng'
    );
    expect(pkgs.exitCode, `ipk add stderr: ${pkgs.stderr}`).toBe(0);
    // The 92 MB `model_quantized.onnx` write intermittently trips one of two
    // transient failures in the same operation:
    //   a. the `@zenfs/dom` + kerium bug this file's header documents for
    //      whisper's 188 MB decoder (`EINVAL: Cannot set property message of
    //      … which has only a getter`) — recoverable in place;
    //   b. Chromium's OPFS writable stream dying mid-write (`EINVAL: Failed
    //      to write data to data pipe`, mojo pipe under runner load). Once it
    //      dies, further BIG writes from the same kernel-worker storage
    //      session fail within seconds while small writes still succeed
    //      (observed dequeuing #2037), so in-place retries cannot recover —
    //      only a page reboot gets a fresh worker + storage connection.
    // Retry ONLY this staging step — first in place (a), then ONE reboot (b).
    // It is a known-transient defect in one operation, not a licence to
    // re-run the spec until it passes: the spec keeps `retries: 0` and the
    // phonemizer assertions below stay single-shot.
    const KOKORO_DL_CMD =
      'hf download onnx-community/Kokoro-82M-v1.0-ONNX ' +
      'config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx';
    const TRANSIENT_WRITE_FAILURE = /Cannot set property message|EINVAL/;
    // Clear the half-written weights before any retry. The failed write leaves
    // a truncated `model_quantized.onnx` behind, and downloading over it
    // yields a file whose size does not match its metadata — the model then
    // fails to load with `EIO … Unexpected mismatch in file data size`, which
    // reads like a corrupt download rather than a retried one.
    const clearPartialWeights = () =>
      exec(page, 'rm -rf /workspace/models/onnx-community/Kokoro-82M-v1.0-ONNX');
    let kokoroDl = { exitCode: 1, stdout: '', stderr: 'not attempted' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      kokoroDl = await exec(page, KOKORO_DL_CMD);
      if (kokoroDl.exitCode === 0) break;
      if (!TRANSIENT_WRITE_FAILURE.test(kokoroDl.stderr)) break; // a real failure
      await clearPartialWeights();
      // eslint-disable-next-line no-console
      console.warn(
        `hf download hit a transient OPFS write failure (attempt ${attempt}/3); retrying clean`
      );
    }
    if (kokoroDl.exitCode !== 0 && TRANSIENT_WRITE_FAILURE.test(kokoroDl.stderr)) {
      // eslint-disable-next-line no-console
      console.warn(
        'hf download still failing after in-place retries; rebooting the leader page once'
      );
      await bootLeader({ firstRun: false });
      await clearPartialWeights();
      kokoroDl = await exec(page, KOKORO_DL_CMD);
    }
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
    if (synth.exitCode !== 0) {
      // `say` reports an unusable engine as `Invalid language identifier:
      // "en-us". Should be one of: .` — an EMPTY set, which says the phonemizer
      // came up with no languages but not why. The voice list and the storage
      // numbers are what separate "assets never landed" from "engine loaded but
      // has no voices", so gather both before failing.
      const voices = await exec(page, 'say --list');
      const rejections = await page.evaluate(
        () => (window as unknown as { __sliccRejections?: string[] }).__sliccRejections ?? []
      );
      expect(
        synth.exitCode,
        `synth stderr: ${synth.stderr}` +
          `\nsay --list (exit ${voices.exitCode}): ${voices.stdout.trim() || '(no voices listed)'}` +
          `\nunhandled rejections (${rejections.length}):\n${rejections.slice(0, 5).join('\n---\n') || '(none)'}` +
          `\n${await storageReport(page)}` +
          `\n--- diag ---\n${diagTail(diagnostics)}`
      ).toBe(0);
    }
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
