/**
 * Shared `slicc.screenshot()` helpers for the fragment bridge and the
 * full-document iframe copy. Error strings and the SVG wrapper must stay in
 * lockstep — the iframe injects the formatter/`buildScreenshotSvg` functions
 * via `Function#toString()` (assigned to known `var` names so minify is safe).
 */

/** Chromium data-URL length at which we refuse to fall back from a blob URL. */
export const SCREENSHOT_DATA_URL_LIMIT = 2 * 1024 * 1024;

export function screenshotTargetLabel(selector?: string, target?: Element | null): string {
  if (selector) return selector;
  if (typeof document !== 'undefined' && target === document.body) return 'document.body';
  return 'container';
}

export function screenshotZeroDimensionError(label: string, width: number, height: number): string {
  return 'Element has zero dimensions (' + label + ', ' + width + 'x' + height + ')';
}

export function screenshotRasteriseError(
  reason: string,
  label: string,
  width: number,
  height: number,
  svgBytes?: number,
  dataUrlBytes?: number
): string {
  let msg = 'Screenshot rendering failed (' + reason + '; ' + label + ' ' + width + 'x' + height;
  if (svgBytes) msg += '; serialised SVG ' + svgBytes + ' bytes';
  if (dataUrlBytes) msg += '; data URL ' + dataUrlBytes + ' bytes';
  return msg + ')';
}

/**
 * Wrap a serialised HTML clone in an SVG `foreignObject` with an XHTML
 * namespace. Missing xmlns is a common reason Chrome's SVG-as-image decoder
 * fires `img.onerror` on an otherwise sized target.
 */
export function buildScreenshotSvg(xhtml: string, width: number, height: number): string {
  let wrapped = xhtml;
  if (xhtml.indexOf('xmlns="http://www.w3.org/1999/xhtml"') === -1) {
    wrapped = '<div xmlns="http://www.w3.org/1999/xhtml">' + xhtml + '</div>';
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '">' +
    '<foreignObject width="100%" height="100%" xmlns="http://www.w3.org/1999/xhtml">' +
    wrapped +
    '</foreignObject></svg>'
  );
}

/** Formatter + SVG-builder source injected into full-document sprinkle iframes. */
export function iframeScreenshotHelpersSource(): string {
  return (
    'var screenshotTargetLabel = ' +
    screenshotTargetLabel.toString() +
    ';\n' +
    'var screenshotZeroDimensionError = ' +
    screenshotZeroDimensionError.toString() +
    ';\n' +
    'var screenshotRasteriseError = ' +
    screenshotRasteriseError.toString() +
    ';\n' +
    'var buildScreenshotSvg = ' +
    buildScreenshotSvg.toString() +
    ';\n'
  );
}

/**
 * Capture a sprinkle DOM node as a PNG data URL.
 * Keep the iframe `screenshot()` body in `sprinkle-renderer.ts` in lockstep.
 */
export async function captureSprinkleScreenshot(
  selector?: string,
  defaultRoot?: Element | null
): Promise<string> {
  const root = defaultRoot ?? document.body;
  const target = selector ? root.querySelector(selector) : root;
  const label = screenshotTargetLabel(selector, target);
  if (!target) throw new Error('Element not found: ' + (selector || label));
  const rect = target.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  if (width === 0 || height === 0) {
    throw new Error(screenshotZeroDimensionError(label, rect.width, rect.height));
  }

  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(screenshotRasteriseError('canvas context unavailable', label, width, height));
  }
  ctx.scale(dpr, dpr);

  const clone = target.cloneNode(true);
  stripNonRasterisableClone(clone);

  let xhtml: string;
  try {
    xhtml = new XMLSerializer().serializeToString(clone);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      screenshotRasteriseError('XMLSerializer threw: ' + message, label, width, height)
    );
  }

  const svg = buildScreenshotSvg(xhtml, width, height);
  return rasteriseSvgToPng(svg, ctx, canvas, label, width, height);
}

function stripNonRasterisableClone(clone: Node): void {
  if (!('querySelectorAll' in clone)) return;
  const junk = (clone as Element).querySelectorAll('script, link[rel="stylesheet"]');
  for (let i = 0; i < junk.length; i++) {
    junk[i].parentNode?.removeChild(junk[i]);
  }
}

function rasteriseSvgToPng(
  svg: string,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  label: string,
  width: number,
  height: number
): Promise<string> {
  const svgBytes = svg.length;
  let dataUrl: string;
  try {
    dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  } catch {
    return Promise.reject(
      new Error(screenshotRasteriseError('data-URL too large', label, width, height, svgBytes))
    );
  }
  const dataUrlBytes = dataUrl.length;
  const source = resolveScreenshotImageSrc(svg, dataUrl, dataUrlBytes, label, width, height);
  if (source instanceof Error) return Promise.reject(source);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const cleanup = () => {
      if (source.blobUrl) {
        try {
          URL.revokeObjectURL(source.blobUrl);
        } catch {
          /* ignore */
        }
      }
    };
    img.onload = () => {
      cleanup();
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      cleanup();
      const oversizedDataUrl = !source.blobUrl && dataUrlBytes > SCREENSHOT_DATA_URL_LIMIT;
      const reason = oversizedDataUrl ? 'data-URL too large' : 'image decode failed';
      reject(
        new Error(screenshotRasteriseError(reason, label, width, height, svgBytes, dataUrlBytes))
      );
    };
    img.src = source.src;
  });
}

function resolveScreenshotImageSrc(
  svg: string,
  dataUrl: string,
  dataUrlBytes: number,
  label: string,
  width: number,
  height: number
): { src: string; blobUrl: string | null } | Error {
  const tooLarge = () =>
    new Error(
      screenshotRasteriseError('data-URL too large', label, width, height, svg.length, dataUrlBytes)
    );
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      return { src: blobUrl, blobUrl };
    } catch {
      if (dataUrlBytes > SCREENSHOT_DATA_URL_LIMIT) return tooLarge();
      return { src: dataUrl, blobUrl: null };
    }
  }
  if (dataUrlBytes > SCREENSHOT_DATA_URL_LIMIT) return tooLarge();
  return { src: dataUrl, blobUrl: null };
}
