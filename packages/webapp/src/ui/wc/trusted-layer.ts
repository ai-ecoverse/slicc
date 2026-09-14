export const PANEL_HOST_CLASS = 'wcui-panel-host';

export const TRUSTED_LAYER_CLASS = 'wcui-trusted-layer';

export const TRUSTED_LAYER_CSS = [
  `.${PANEL_HOST_CLASS}{position:absolute;inset:0;isolation:isolate;`,
  'display:flex;flex-direction:column;min-width:0;min-height:0;}',
  `.${TRUSTED_LAYER_CLASS}{position:absolute;inset:0;pointer-events:none;`,

  'display:flex;flex-direction:column;}',
  `.${TRUSTED_LAYER_CLASS}>*{pointer-events:auto;}`,
].join('');

export function buildTrustedLayers(doc: Document = document): {
  panelHost: HTMLElement;
  trustedLayer: HTMLElement;
} {
  const panelHost = doc.createElement('div');
  panelHost.className = PANEL_HOST_CLASS;

  const trustedLayer = doc.createElement('div');
  trustedLayer.className = TRUSTED_LAYER_CLASS;

  trustedLayer.setAttribute('data-slicc-trusted', '');

  return { panelHost, trustedLayer };
}

export function isInTrustedLayer(node: Node | null): boolean {
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest(`.${TRUSTED_LAYER_CLASS}`);
}

export function mountTrusted(chrome: HTMLElement, doc: Document = document): void {
  const layer = doc.querySelector(`.${TRUSTED_LAYER_CLASS}`);
  if (!layer) {
    throw new Error(
      'trusted layer not found — approval chrome must not fall back to document.body ' +
        '(it would be occludable by a panel; see trusted-layer.ts)'
    );
  }
  layer.appendChild(chrome);
}
