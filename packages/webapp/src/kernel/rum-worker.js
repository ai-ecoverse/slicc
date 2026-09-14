export default function sampleRUM(checkpoint, data = {}) {
  try {
    if (typeof self === 'undefined' || typeof navigator === 'undefined') return;
    if (typeof navigator.sendBeacon !== 'function') return;
    const g = globalThis;
    g.hlx = g.hlx || {};
    if (!g.hlx.rum) {
      let debug = false;
      try {
        debug =
          typeof localStorage !== 'undefined' && localStorage.getItem('slicc-rum-debug') === '1';
      } catch {}
      const weight = debug ? 1 : 10;
      const random = Math.random();
      const isSelected = random * weight < 1;
      const href = self.location?.href || '';
      const id = `${hashCode(href)}-${Date.now()}-${rand14()}`;
      g.hlx.rum = { weight, id, random, isSelected, sampleRUM };
    }
    const { weight, id, isSelected } = g.hlx.rum;
    if (!isSelected) return;
    const href = self.location?.href || '';
    const body = JSON.stringify({
      weight,
      id,
      referer: href,
      generation: g.RUM_GENERATION,
      checkpoint,
      ...data,
    });
    navigator.sendBeacon(`https://rum.hlx.page/.rum/${weight}`, body);
  } catch {}
}

function hashCode(s) {
  return s.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
}

function rand14() {
  return Math.random().toString(16).slice(2, 16);
}
