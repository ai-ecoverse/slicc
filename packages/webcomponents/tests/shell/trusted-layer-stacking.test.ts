/**
 * H2 — real-browser proof that the trusted layer cannot be occluded.
 *
 * The webapp-side unit tests (`packages/webapp/tests/ui/wc/trusted-layer.test.ts`)
 * run in jsdom, which does not composite, so they can only assert the invariants
 * that *should* produce correct stacking. This suite runs in real Chromium
 * (`@vitest/browser`) and asserts the outcome the design actually promises, via
 * the browser's own hit-test (`elementFromPoint`): a panel setting the maximum
 * possible `z-index` still loses to trusted chrome that sets none.
 *
 * It lives here — not in the webapp package — purely because this is the repo's
 * only real-browser test project. The CSS under test is authored in
 * `packages/webapp/src/ui/wc/trusted-layer.ts`; the two rules below are a
 * deliberate copy of its load-bearing declarations, kept minimal so a drift
 * between them shows up as this test passing while the webapp unit test's
 * `TRUSTED_LAYER_CSS` assertions fail (or vice versa).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The two declarations that create the guarantee, mirroring
 * `TRUSTED_LAYER_CSS`: a stacking context on the panel host, and NO z-index on
 * the trusted layer (ordering comes from sibling order alone).
 */
const CSS = `
.probe-frame { position: relative; width: 600px; height: 400px; display: flex; }
/* \`flex:1 1 auto\` + the flex frame mirror production: the host must actually
   FILL the frame, otherwise a panel's \`inset:0\` resolves against a zero-size
   box and the fall-through assertion below tests nothing. */
.probe-panel-host { position: relative; isolation: isolate; flex: 1 1 auto;
  display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.probe-trusted-layer { position: absolute; inset: 0; pointer-events: none; }
.probe-trusted-layer > * { pointer-events: auto; }
`;

let style: HTMLStyleElement;
let frame: HTMLElement;

beforeEach(() => {
  style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  frame = document.createElement('div');
  frame.className = 'probe-frame';
  document.body.appendChild(frame);
});

afterEach(() => {
  style.remove();
  frame.remove();
});

/** Build the host/layer pair in the guaranteed order (host first, layer after). */
function buildLayers(): { host: HTMLElement; layer: HTMLElement } {
  const host = document.createElement('div');
  host.className = 'probe-panel-host';
  const layer = document.createElement('div');
  layer.className = 'probe-trusted-layer';
  frame.append(host, layer);
  return { host, layer };
}

/** A 100×100 box at (200,200) inside `parent`, optionally with a `z-index`. */
function box(parent: HTMLElement, id: string, zIndex?: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = 'position:absolute;top:200px;left:200px;width:100px;height:100px;';
  if (zIndex !== undefined) {
    el.style.position = 'fixed';
    el.style.zIndex = zIndex;
  }
  parent.appendChild(el);
  return el;
}

describe('trusted layer stacking (real browser)', () => {
  it('trusted chrome paints above a panel using the maximum 32-bit z-index', () => {
    const { host, layer } = buildLayers();
    box(layer, 'trusted');
    box(host, 'hostile', '2147483647');

    // The browser's own hit-test IS the compositing answer.
    expect(document.elementFromPoint(250, 250)?.id).toBe('trusted');
  });

  it('holds for a panel nested deep inside the host', () => {
    // A panel's own descendant must not escape either — the clamp is on the
    // host's stacking context, so nesting depth is irrelevant.
    const { host, layer } = buildLayers();
    box(layer, 'trusted');
    let cursor: HTMLElement = host;
    for (let i = 0; i < 5; i++) {
      const nested = document.createElement('div');
      nested.style.cssText = 'position:relative;z-index:999999;';
      cursor.appendChild(nested);
      cursor = nested;
    }
    box(cursor, 'hostile-deep', '2147483647');

    expect(document.elementFromPoint(250, 250)?.id).toBe('trusted');
  });

  it('WITHOUT the isolation on the host, the hostile panel wins — proving isolation is load-bearing', () => {
    // The counter-test: remove the one declaration the design rests on and the
    // guarantee collapses. This is what stops a future refactor from dropping
    // `isolation:isolate` and leaving the other tests green.
    const { host, layer } = buildLayers();
    host.style.isolation = 'auto';
    box(layer, 'trusted');
    box(host, 'hostile', '2147483647');

    expect(document.elementFromPoint(250, 250)?.id).toBe('hostile');
  });

  it('clicks fall through the empty regions of the trusted layer to the panel beneath', () => {
    // `pointer-events:none` on the layer (with `auto` on its children) means the
    // layer spanning the whole frame does not swallow interaction with panels.
    const { host, layer } = buildLayers();
    box(layer, 'trusted'); // occupies (200,200)-(300,300) only
    const panel = document.createElement('div');
    panel.id = 'panel-underneath';
    panel.style.cssText = 'position:absolute;inset:0;';
    host.appendChild(panel);

    // A point OUTSIDE the trusted chrome reaches the panel...
    expect(document.elementFromPoint(50, 50)?.id).toBe('panel-underneath');
    // ...while a point inside it still hits the trusted chrome.
    expect(document.elementFromPoint(250, 250)?.id).toBe('trusted');
  });
});
