import { ORT_WEB_VERSION } from '../../src/speech/ort-version.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';
import { type ExecResult, execInTerminal, openTerminal } from './two-instance-helpers.js';

const RUN = process.env['RUN_REAL_SPEECH_E2E'] === '1';

async function exec(page: import('@playwright/test').Page, cmd: string): Promise<ExecResult> {
  return execInTerminal(page, cmd);
}

function attachBrowserDiagnostics(page: import('@playwright/test').Page): { entries: string[] } {
  const entries: string[] = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (
      type === 'error' ||
      type === 'warning' ||
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
  const tail = diagnostics.entries.slice(-120).join('\n');
  return tail || '(no browser diagnostics captured)';
}

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
  test.describe.configure({ retries: 1 });

  test.skip(
    !RUN,
    'set RUN_REAL_SPEECH_E2E=1 to opt in (downloads ~100 MB of kokoro weights on a cold OPFS)'
  );

  test('writes a valid kokoro-synthesized WAV', async ({ page }) => {
    test.setTimeout(25 * 60_000);

    const diagnostics = attachBrowserDiagnostics(page);

    await page.addInitScript(() => {
      try {
        delete (Navigator.prototype as unknown as { gpu?: unknown }).gpu;
        delete (navigator as unknown as { gpu?: unknown }).gpu;
      } catch {}

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

    const bootLeader = async ({ firstRun = true }: { firstRun?: boolean } = {}) => {
      await gotoLeader(page);
      await waitForSW(page);

      await page.waitForSelector('slicc-input-card');
      if (firstRun) {
        await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
          timeout: 20_000,
        });
      }

      await openTerminal(page);
    };
    await bootLeader();

    const hfEndpoint = process.env['HF_ENDPOINT'];
    if (hfEndpoint) {
      const exported = await exec(page, `export HF_ENDPOINT=${JSON.stringify(hfEndpoint)}`);
      expect(exported.exitCode, `export HF_ENDPOINT stderr: ${exported.stderr}`).toBe(0);
    }

    const pkgs = await exec(
      page,
      `cd /workspace && ipk add onnxruntime-web@${ORT_WEB_VERSION} espeak-ng`
    );
    expect(pkgs.exitCode, `ipk add stderr: ${pkgs.stderr}`).toBe(0);

    const KOKORO_DL_CMD =
      'hf download onnx-community/Kokoro-82M-v1.0-ONNX ' +
      'config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx';
    const TRANSIENT_WRITE_FAILURE = /Cannot set property message|Failed to write data to data pipe/;
    const QUOTA_FAILURE = /storage quota|QuotaExceededError/;

    const clearPartialWeights = () =>
      exec(page, 'rm -rf /workspace/models/onnx-community/Kokoro-82M-v1.0-ONNX');
    let kokoroDl = { exitCode: 1, stdout: '', stderr: 'not attempted' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      kokoroDl = await exec(page, KOKORO_DL_CMD);
      if (kokoroDl.exitCode === 0) break;
      if (!TRANSIENT_WRITE_FAILURE.test(kokoroDl.stderr)) break;
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
    expect(
      kokoroDl.exitCode,
      `hf kokoro stderr: ${kokoroDl.stderr}` +
        (QUOTA_FAILURE.test(kokoroDl.stderr) ? `\n${await storageReport(page)}` : '')
    ).toBe(0);

    const warmup = await exec(page, 'say --warmup');
    expect(warmup.exitCode, `warmup stderr: ${warmup.stderr}`).toBe(0);
    await waitForReady(page, 'say --status', /voice engine: ready/, 5 * 60_000, diagnostics);

    const outPath = '/tmp/say-out.wav';
    const synth = await exec(page, `say -l en-US -o ${outPath} "hello world"`);
    if (synth.exitCode !== 0) {
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

    const ls = await exec(page, `wc -c ${outPath}`);
    expect(ls.exitCode, `wc stderr: ${ls.stderr}`).toBe(0);
    const sizeMatch = ls.stdout.trim().match(/^(\d+)/);
    expect(sizeMatch, `wc stdout: ${ls.stdout}`).not.toBeNull();
    expect(Number(sizeMatch![1])).toBeGreaterThan(8_000);

    const magic = await exec(page, `head -c 4 ${outPath}`);
    expect(magic.exitCode, `head stderr: ${magic.stderr}`).toBe(0);
    expect(magic.stdout).toBe('RIFF');
  });
});
