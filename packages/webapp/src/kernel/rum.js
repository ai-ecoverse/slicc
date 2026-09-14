export default function sampleRUM(checkpoint, data = {}) {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    window.hlx = window.hlx || {};
    if (!window.hlx.rum) {
      let debug = false;
      try {
        debug = localStorage.getItem('slicc-rum-debug') === '1';
      } catch {}
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
  } catch {}
}

function hashCode(s) {
  return s.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
}

function rand14() {
  return Math.random().toString(16).slice(2, 16);
}
