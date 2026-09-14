import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('regression: mountTerminal is gated on kernel-ready', () => {
  const WC_LIVE = resolve(__dirname, '../../../src/ui/wc/wc-live.ts');
  const src = readFileSync(WC_LIVE, 'utf8');

  it('awaits boot.onClientReady before calling view.mount in mountWorkbenchTerminal', () => {
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
    expect(src).toMatch(
      /await\s+new\s+Promise<void>\s*\(\s*\(\s*resolve\s*\)\s*=>\s*boot\.onClientReady\s*\(\s*resolve\s*\)\s*\)/
    );
  });

  it('workbench activator wires mountTerminal through the helper', () => {
    expect(src).toMatch(/mountTerminal:\s*\(container\)\s*=>\s*mountWorkbenchTerminal\(/);
  });

  it('publishes the mounted view on __slicc_terminal_view after view.mount', () => {
    const idx = src.indexOf('async function mountWorkbenchTerminal');
    const tail = src.slice(idx);
    const mountIdx = tail.indexOf('view.mount(');
    const publishIdx = tail.indexOf('__slicc_terminal_view');
    expect(publishIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeLessThan(publishIdx);
  });
});

describe('regression: __slicc_kernel_ready is published after host.ready', () => {
  const WC_LIVE = resolve(__dirname, '../../../src/ui/wc/wc-live.ts');
  const src = readFileSync(WC_LIVE, 'utf8');

  it('assigns __slicc_kernel_ready only after await kernel.ready', () => {
    const readyIdx = src.indexOf('await kernel.ready');
    const publishIdx = src.lastIndexOf('__slicc_kernel_ready');
    expect(readyIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(readyIdx);
  });
});
