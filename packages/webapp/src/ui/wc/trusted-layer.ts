/**
 * `trusted-layer.ts` — the spoof-proof top layer (H2).
 *
 * ## The problem
 *
 * Panels rendered in the page realm — including ones SLICC itself authors at
 * runtime — can draw arbitrary DOM. Nothing stops such a panel from rendering a
 * convincing fake approval dialog, a fake "enter your API key" form, or simply
 * covering the real avatar menu with its own chrome. A sandboxed sprinkle is
 * visually confined to its iframe box; a main-realm panel is not. This is the
 * one capability a panel has that has no equivalent in today's UI, so it needs a
 * structural answer rather than a convention.
 *
 * ## The mechanism: a stacking context, not a z-index race
 *
 * `z-index` only orders siblings **within the same stacking context**. So the
 * fix is not "give the trusted chrome a bigger number" (an arms race a panel
 * always wins by adding a nine) — it is to put every panel inside a host that
 * *establishes its own stacking context*, and put the trusted layer OUTSIDE it
 * as a later sibling:
 *
 *   .wcui-frame                       ← the shared root
 *     ├─ .wcui-panel-host            ← isolation:isolate  (own stacking context)
 *     │     └─ …every panel…         ← z-index:99999 here is clamped to the host
 *     └─ .wcui-trusted-layer         ← later sibling ⇒ always paints above
 *
 * Once `.wcui-panel-host` is a stacking context, the largest `z-index` any
 * descendant can reach is still *inside* that context; the whole subtree is
 * composited as one unit and ordered against `.wcui-trusted-layer` by their own
 * sibling order. A panel therefore cannot paint over trusted chrome regardless
 * of the values it sets. `isolation: isolate` is used (rather than a `z-index`
 * on the host) because it creates the stacking context without joining the
 * numeric ordering game at all.
 *
 * What lives in the trusted layer: the fixed avatar strip and every
 * approval/permission/consent overlay. Nothing else — it is deliberately small,
 * because everything in it is UI the user must be able to believe.
 *
 * ## What this does and does not buy
 *
 * It reliably prevents *visual* spoofing and occlusion of trusted chrome. It is
 * NOT a capability boundary: a main-realm panel can still reach `document` and
 * mutate the trusted layer's contents directly if it wants to. Guarding against
 * *that* needs realm isolation (a dedicated sandbox origin — issue #1717's
 * "option C"), not painting order. As everywhere else in SLICC, the trust model
 * is the real boundary; this closes the accidental and opportunistic cases and
 * makes the deliberate one require obviously-malicious code rather than a
 * stray `z-index`.
 */

/** Class on the container every panel/layout renders inside (the clamped context). */
export const PANEL_HOST_CLASS = 'wcui-panel-host';

/** Class on the trusted top layer — fixed chrome + approval overlays only. */
export const TRUSTED_LAYER_CLASS = 'wcui-trusted-layer';

/**
 * CSS for the two-layer split. Appended to the shell stylesheet rather than
 * injected separately so there is exactly one place that owns frame layout.
 *
 * `isolation:isolate` on the panel host is the load-bearing declaration — see
 * the module doc. `pointer-events:none` on the trusted layer with `auto` restored
 * on its children lets clicks fall through the empty regions of the layer to the
 * panels underneath (the layer spans the frame, but only its actual chrome should
 * be interactive).
 *
 * The host is sized by ABSOLUTE INSET rather than `flex:1`. It sits inside
 * `.wcui-frame`, which is `display:block` — so a flex-item height would resolve
 * to zero and silently collapse every panel inside it (measured: the whole layout
 * came out 0px tall). `position:absolute; inset:0` inside the frame's
 * `position:relative` box gives it the frame's full height regardless of whether
 * the frame is block or flex, which also keeps it robust if the frame's display
 * mode changes again. Same treatment for the trusted layer, which already used
 * inset.
 */
export const TRUSTED_LAYER_CSS = [
  `.${PANEL_HOST_CLASS}{position:absolute;inset:0;isolation:isolate;`,
  'display:flex;flex-direction:column;min-width:0;min-height:0;}',
  `.${TRUSTED_LAYER_CLASS}{position:absolute;inset:0;pointer-events:none;`,
  // No z-index: ordering against the panel host comes from sibling order, and
  // adding one here would invite the arms race this design exists to avoid.
  'display:flex;flex-direction:column;}',
  `.${TRUSTED_LAYER_CLASS}>*{pointer-events:auto;}`,
].join('');

/**
 * Build the panel host + trusted layer pair for a frame.
 *
 * Order matters and is enforced here rather than left to callers: the trusted
 * layer MUST be appended after the panel host, because that sibling order is
 * what makes it paint above (see the module doc). Callers append their layout
 * into `panelHost` and their fixed chrome into `trustedLayer`.
 */
export function buildTrustedLayers(doc: Document = document): {
  panelHost: HTMLElement;
  trustedLayer: HTMLElement;
} {
  const panelHost = doc.createElement('div');
  panelHost.className = PANEL_HOST_CLASS;

  const trustedLayer = doc.createElement('div');
  trustedLayer.className = TRUSTED_LAYER_CLASS;
  // Announce it as a distinct region so assistive tech (and any future audit
  // tooling) can tell trusted chrome from panel content.
  trustedLayer.setAttribute('data-slicc-trusted', '');

  return { panelHost, trustedLayer };
}

/**
 * Whether `node` sits inside the trusted layer — i.e. whether it is chrome the
 * user is entitled to believe. Used by approval surfaces to assert they mounted
 * into the right layer, and available to tests/audits as the single predicate
 * that defines "trusted" structurally instead of by naming convention.
 */
export function isInTrustedLayer(node: Node | null): boolean {
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest(`.${TRUSTED_LAYER_CLASS}`);
}

/**
 * Mount `chrome` into the trusted layer, failing loudly if the layer is absent.
 *
 * Approval/consent UI should route through this instead of
 * `document.body.append` so a refactor that drops the layer surfaces as an
 * error rather than as silently spoofable chrome.
 */
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
