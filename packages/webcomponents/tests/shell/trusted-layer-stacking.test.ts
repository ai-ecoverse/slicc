import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

function buildLayers(): { host: HTMLElement; layer: HTMLElement } {
  const host = document.createElement('div');
  host.className = 'probe-panel-host';
  const layer = document.createElement('div');
  layer.className = 'probe-trusted-layer';
  frame.append(host, layer);
  return { host, layer };
}

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

    expect(document.elementFromPoint(250, 250)?.id).toBe('trusted');
  });

  it('holds for a panel nested deep inside the host', () => {
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
    const { host, layer } = buildLayers();
    host.style.isolation = 'auto';
    box(layer, 'trusted');
    box(host, 'hostile', '2147483647');

    expect(document.elementFromPoint(250, 250)?.id).toBe('hostile');
  });

  it('clicks fall through the empty regions of the trusted layer to the panel beneath', () => {
    const { host, layer } = buildLayers();
    box(layer, 'trusted');
    const panel = document.createElement('div');
    panel.id = 'panel-underneath';
    panel.style.cssText = 'position:absolute;inset:0;';
    host.appendChild(panel);

    expect(document.elementFromPoint(50, 50)?.id).toBe('panel-underneath');

    expect(document.elementFromPoint(250, 250)?.id).toBe('trusted');
  });
});

describe('floating panels stay under the trusted layer', () => {
  it('a floating panel cannot occlude trusted chrome', () => {
    const { host, layer } = buildLayers();
    box(layer, 'trusted');

    const floating = document.createElement('div');
    floating.id = 'floating-panel';

    floating.style.cssText =
      'position:absolute;z-index:1;top:200px;left:200px;width:100px;height:100px;';
    host.appendChild(floating);

    expect(document.elementFromPoint(250, 250)?.id).toBe('trusted');
  });
});
