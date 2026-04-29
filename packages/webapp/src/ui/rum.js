/* eslint-disable no-undef */
/**
 * Inlined Helix RUM sampler — extension panel only.
 * Modeled on @adobe/aem-sidekick's src/extension/utils/rum.js.
 * Fires fire-and-forget beacons via navigator.sendBeacon to rum.hlx.page.
 *
 * Substitutions vs aem-sidekick (which operates on a target-page URL):
 *   - pageview source: window.location (side-panel URL, not target page)
 *   - debug flag: localStorage 'slicc-rum-debug' === '1' (no usable URL query in side panel)
 *   - generation: window.RUM_GENERATION (SLICC custom, set by telemetry.ts)
 */

export default function sampleRUM(checkpoint, data = {}) {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    window.hlx = window.hlx || {};
    if (!window.hlx.rum) {
      // Sampling decision is per-pageview. Cache state on window.hlx.rum so
      // every sampleRUM() call within this page lifetime reuses the same
      // weight, id, and isSelected verdict. Side-panel close/reopen produces
      // a fresh init with a new decision.
      let debug = false;
      try {
        debug = localStorage.getItem('slicc-rum-debug') === '1';
      } catch {
        // localStorage.getItem can throw in restricted privacy contexts
        // (e.g., private browsing with storage disabled). Fall back to default weight.
      }
      const weight = debug ? 1 : 10;
      const random = Math.random();
      const isSelected = random * weight < 1;
      const id = `${hashCode(window.location.href)}-${Date.now()}-${rand14()}`;
      window.hlx.rum = { weight, id, random, isSelected, sampleRUM };
    }
    const { weight, id, isSelected } = window.hlx.rum;
    if (!isSelected) return;
    const body = JSON.stringify({
      weight,
      id,
      referer: window.location.href,
      generation: window.RUM_GENERATION,
      checkpoint,
      ...data,
    });
    navigator.sendBeacon(`https://rum.hlx.page/.rum/${weight}`, body);
  } catch {
    // never throw
  }
}

function hashCode(s) {
  return s.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
}

function rand14() {
  return Math.random().toString(16).slice(2, 16);
}
