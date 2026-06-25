/**
 * Regression guard: the workbench `mountTerminal` lambda in `wc-live.ts`
 * MUST await `boot.onClientReady` before calling `view.mount(container)`.
 *
 * The race: the workbench activator fires on the first `term` surface
 * activation, which can land BEFORE the worker's `TerminalSessionHost`
 * subscribes. The fire-once `terminal-open` is then dropped by the
 * message bus, the banner renders, and the prompt never appears.
 *
 * The fix mirrors the freezer/stats/sprinkle pattern already in the file
 * — wait for kernel-ready, then mount. The defense-in-depth retry inside
 * `TerminalSessionClient.open()` covers the (vanishingly small) remaining
 * window, but this gate keeps the retry from firing in production.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('regression: mountTerminal is gated on kernel-ready', () => {
  const WC_LIVE = resolve(__dirname, '../../../src/ui/wc/wc-live.ts');
  const src = readFileSync(WC_LIVE, 'utf8');

  it('awaits boot.onClientReady before calling view.mount in mountWorkbenchTerminal', () => {
    // Locate the helper body and assert the order: `boot.onClientReady` appears
    // before `view.mount(`.
    const idx = src.indexOf('async function mountWorkbenchTerminal');
    expect(idx).toBeGreaterThan(-1);
    const tail = src.slice(idx);
    const readyIdx = tail.indexOf('boot.onClientReady');
    const mountIdx = tail.indexOf('view.mount(');
    expect(readyIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeLessThan(mountIdx);
  });

  it('wraps the onClientReady gate in an awaited Promise', () => {
    // `boot.onClientReady(fn)` fires immediately when the kernel is
    // already ready and once on the next ready transition otherwise —
    // both code paths must block the mount.
    expect(src).toMatch(
      /await\s+new\s+Promise<void>\s*\(\s*\(\s*resolve\s*\)\s*=>\s*boot\.onClientReady\s*\(\s*resolve\s*\)\s*\)/
    );
  });

  it('workbench activator wires mountTerminal through the helper', () => {
    expect(src).toMatch(/mountTerminal:\s*\(container\)\s*=>\s*mountWorkbenchTerminal\(/);
  });

  it('publishes the mounted view on __slicc_terminal_view after view.mount', () => {
    // E2E seam consumed by `tests/e2e/speech-roundtrip.test.ts`. The
    // publish must follow `view.mount(` so Playwright never observes a
    // half-constructed view (open session, pre-`mount` line editor).
    const idx = src.indexOf('async function mountWorkbenchTerminal');
    const tail = src.slice(idx);
    const mountIdx = tail.indexOf('view.mount(');
    const publishIdx = tail.indexOf('__slicc_terminal_view');
    expect(publishIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeLessThan(publishIdx);
  });
});
