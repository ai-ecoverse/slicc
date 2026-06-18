// @vitest-environment jsdom
/**
 * Tests for the launcher content-script bootstrapper.
 *
 * The content script is registered with `matches: ["<all_urls>"]` in
 * `manifest.json` and runs in the page MAIN world. It MUST NOT inject the
 * `<slicc-launcher>` on the SLICC app origin itself (the leader tab at
 * `https://www.sliccy.ai/?slicc=leader` IS the real SLICC UI, and a
 * cherry iframe loaded from the same origin already runs the webapp) —
 * doing so would stack the launcher on top of itself (self-recursion).
 *
 * Two gates protect against this:
 *   1. `content_scripts[].exclude_matches: ["https://www.sliccy.ai/*"]`
 *      in the manifest (Chrome never runs the script on the SLICC origin).
 *   2. A defensive in-script `shouldInjectLauncher()` guard for the
 *      belt-and-suspenders path (future `all_frames` / programmatic
 *      injection / `executeScript` callers).
 *
 * The `@slicc/webcomponents` launcher module is mocked so importing the
 * content script doesn't drag in the real `define('slicc-launcher')`
 * side effect (Node test runs lack `customElements`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSliccLauncher extends HTMLElement {
  appUrl = '';
}

vi.mock('@slicc/webcomponents/src/launcher/slicc-launcher.js', () => ({
  SliccLauncher: FakeSliccLauncher,
}));

if (!customElements.get('slicc-launcher')) {
  customElements.define('slicc-launcher', FakeSliccLauncher);
}

const PKG_ROOT = resolve(__dirname, '..');
const LAUNCHER_HOST_ID = 'slicc-electron-overlay-root';
const SLICC_APP_URL = 'https://www.sliccy.ai/?cherry=1';

type ContentScriptModule = typeof import('../src/content-script.js');

describe('content-script bootstrap (origin guard)', () => {
  let mod: ContentScriptModule;

  beforeEach(async () => {
    vi.resetModules();
    mod = (await import('../src/content-script.js')) as ContentScriptModule;
    // Wipe any element injected by the auto-invoked `bootstrap(location.origin)`
    // at module load — each test asserts on a clean body.
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('exposes SLICC_APP_ORIGIN as the canonical sliccy.ai origin', () => {
    expect(mod.SLICC_APP_ORIGIN).toBe('https://www.sliccy.ai');
  });

  it('shouldInjectLauncher returns false on the SLICC origin', () => {
    expect(mod.shouldInjectLauncher('https://www.sliccy.ai')).toBe(false);
  });

  it('shouldInjectLauncher returns true on arbitrary host origins', () => {
    expect(mod.shouldInjectLauncher('https://example.com')).toBe(true);
    expect(mod.shouldInjectLauncher('http://localhost:5710')).toBe(true);
    expect(mod.shouldInjectLauncher('https://sliccy.ai')).toBe(true); // apex, not www
  });

  it('bootstrap skips injection on the SLICC origin', () => {
    mod.bootstrap('https://www.sliccy.ai');
    expect(document.getElementById(LAUNCHER_HOST_ID)).toBeNull();
  });

  it('bootstrap injects the launcher on a non-SLICC origin', () => {
    mod.bootstrap('https://example.com');
    const el = document.getElementById(LAUNCHER_HOST_ID);
    expect(el).toBeInstanceOf(FakeSliccLauncher);
    expect((el as FakeSliccLauncher).appUrl).toBe(SLICC_APP_URL);
  });

  it('bootstrap is idempotent on a non-SLICC origin (reuses the existing element)', () => {
    mod.bootstrap('https://example.com');
    mod.bootstrap('https://example.com');
    expect(document.body.querySelectorAll(`#${LAUNCHER_HOST_ID}`)).toHaveLength(1);
  });
});

describe('manifest.json — content_scripts exclude_matches', () => {
  const manifest = JSON.parse(readFileSync(resolve(PKG_ROOT, 'manifest.json'), 'utf-8')) as {
    content_scripts: Array<{
      matches: string[];
      exclude_matches?: string[];
      js: string[];
      world?: string;
    }>;
  };

  it('excludes the SLICC origin from the <all_urls> launcher content-script entry', () => {
    const entry = manifest.content_scripts.find(
      (c) => c.matches.includes('<all_urls>') && c.js.includes('content-script.js')
    );
    expect(entry).toBeDefined();
    expect(entry?.exclude_matches).toEqual(['https://www.sliccy.ai/*']);
  });
});
