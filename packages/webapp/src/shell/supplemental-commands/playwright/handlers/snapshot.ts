/**
 * Page inspection subcommands: snapshot, find, frames, screenshot.
 */

import { isExtensionRealm } from '../../../../base/runtime-env.js';
import { ensureSessionDirs } from '../session-log.js';
import { renderNode, takeSnapshot } from '../snapshot.js';
import {
  base64ToBytes,
  filenameSafeTimestamp,
  parsePageJson,
  requireTab,
  resolveFrame,
} from '../state.js';
import type {
  PlaywrightHandler,
  PlaywrightHandlerCtx,
  PlaywrightState,
  TabSnapshot,
} from '../types.js';

// Named via the handler context rather than imported from `cdp/` so this
// module stays inside the shell layer (see layer-stack import direction).
type BrowserAPI = PlaywrightHandlerCtx['browser'];
type FrameInfo = Awaited<ReturnType<BrowserAPI['getFrameTree']>>[number];

type ScreenshotClip = { x: number; y: number; width: number; height: number; scale?: number };

/**
 * The --depth/--boxes/find/--hires feature code, loaded lazily: the handlers
 * table is in the kernel worker's boot-critical graph (ratcheted by
 * `first-load-budget.json`), and none of it runs until a caller asks for one
 * of those features. Unlike the validate-args chunk, a failed load here must
 * FAIL the command — the caller explicitly requested the feature.
 */
function loadSnapshotFeatures(): Promise<typeof import('./snapshot-features.js')> {
  return import('./snapshot-features.js');
}

async function takeFrameSnapshot(
  browser: BrowserAPI,
  state: PlaywrightState,
  targetId: string,
  frame: FrameInfo
): Promise<string> {
  const tree = await browser.getAccessibilityTreeForFrame(frame.frameId);
  const refToSelector = new Map<string, string>();
  const refToBackendNodeId = new Map<string, number>();
  const refToFrameId = new Map<string, string>();
  const lines = renderNode(tree, refToSelector, refToBackendNodeId, { value: 0 }, '', 'f1');
  for (const ref of refToSelector.keys()) refToFrameId.set(ref, frame.frameId);

  const output = lines.join('\n');
  state.snapshots.set(targetId, {
    url: frame.url,
    title: frame.name,
    refToSelector,
    refToBackendNodeId,
    refToFrameId,
    content: output,
    timestamp: Date.now(),
  });
  return output;
}

/** Resolve a clip rect from a ref via its backendNodeId (preferred, reliable). */
async function clipFromBackendNode(
  browser: BrowserAPI,
  backendNodeId: number
): Promise<ScreenshotClip | undefined> {
  const transport = browser.getTransport();
  const sessionId = browser.getSessionId();
  await transport.send('DOM.enable', {}, sessionId!);
  await transport.send('Runtime.enable', {}, sessionId!);
  const resolveResult = await transport.send('DOM.resolveNode', { backendNodeId }, sessionId!);
  const obj = resolveResult['object'] as { objectId?: string } | undefined;
  if (!obj?.objectId) return undefined;
  const boxResult = await transport.send(
    'Runtime.callFunctionOn',
    {
      objectId: obj.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center' });
        const r = this.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      }`,
      returnByValue: true,
    },
    sessionId!
  );
  return (boxResult['result'] as { value?: ScreenshotClip })?.value;
}

/** Resolve a clip rect from a ref via its CSS selector (fallback). */
async function clipFromSelector(
  browser: BrowserAPI,
  selector: string
): Promise<ScreenshotClip | undefined> {
  const rectJson = await browser.evaluate(
    `(function() {
      const el = document.querySelector(${JSON.stringify(selector.split(',')[0].trim())});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
    })()`
  );
  return rectJson ? parsePageJson<ScreenshotClip>(rectJson, 'element clip rect') : undefined;
}

/** Resolve the bounding box to clip a screenshot to, for a ref like `e5`. */
async function resolveElementClip(
  browser: BrowserAPI,
  snapshot: TabSnapshot,
  ref: string
): Promise<ScreenshotClip | undefined> {
  const backendNodeId = snapshot.refToBackendNodeId.get(ref);
  if (backendNodeId) {
    return clipFromBackendNode(browser, backendNodeId);
  }
  const selector = snapshot.refToSelector.get(ref);
  if (!selector) {
    throw new Error(`Unknown ref "${ref}"`);
  }
  return clipFromSelector(browser, selector);
}

export const snapshotHandler: PlaywrightHandler = async ({ browser, fs, state, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const noIframes = flags['no-iframes'] === 'true';
  const depthRaw = flags['depth'];
  // Strict digits-only — parseInt would silently read "2abc" as 2.
  if (depthRaw !== undefined && !/^[1-9][0-9]*$/.test(depthRaw)) {
    return {
      stdout: '',
      stderr: `snapshot: --depth must be a positive integer, got "${depthRaw}"\n`,
      exitCode: 1,
    };
  }
  const depth = depthRaw === undefined ? undefined : parseInt(depthRaw, 10);
  const boxes = flags['boxes'] === 'true';
  if (boxes && flags['frame']) {
    return {
      stdout: '',
      stderr:
        'snapshot: --boxes is not supported with --frame (child-frame rects live in another coordinate space)\n',
      exitCode: 1,
    };
  }
  let output = await browser.withTab(tab.targetId, async () => {
    const frame = await resolveFrame(browser, flags);
    if (frame) return takeFrameSnapshot(browser, state, tab.targetId, frame);
    const { snapshot, output: text } = await takeSnapshot(browser, state, tab.targetId, {
      noIframes,
    });
    if (!boxes) return text;
    const { annotateBoxes } = await loadSnapshotFeatures();
    return annotateBoxes(browser, snapshot.refToBackendNodeId, text);
  });
  if (depth !== undefined) {
    const { limitSnapshotDepth } = await loadSnapshotFeatures();
    output = limitSnapshotDepth(output, depth);
  }
  if (flags['filename']) {
    await fs.writeFile(flags['filename'], output);
    return {
      stdout: `Snapshot saved to ${flags['filename']}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

/** Search the page snapshot for text or a regexp (implementation lazy-loaded). */
export const findHandler: PlaywrightHandler = async (ctx) => {
  const { findHandlerImpl } = await loadSnapshotFeatures();
  return findHandlerImpl(ctx);
};

export const framesHandler: PlaywrightHandler = async ({ browser, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const output = await browser.withTab(tab.targetId, async () => {
    const frames = await browser.getFrameTree();
    const lines = frames.map((f) => {
      const type = f.parentFrameId ? 'child' : 'main';
      const parent = f.parentFrameId ? ` parentFrameId=${f.parentFrameId}` : '';
      return `  [${type}] frameId=${f.frameId}${parent} - ${f.url}`;
    });
    return `Frame IDs (use with --frame, never --tab):\n${lines.join('\n')}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const pdfHandler: PlaywrightHandler = async ({ browser, fs, flags, scratchDir }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const savePath =
    flags['filename'] || `${scratchDir}/page-${filenameSafeTimestamp(new Date())}.pdf`;

  try {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      const result = await transport.send('Page.printToPDF', {}, sessionId);
      const data = (result as { data: string }).data;
      const bytes = base64ToBytes(data);
      await fs.writeFile(savePath, bytes);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // #2276: stays a `shell/`-owned realm read, not a CapabilityBroker op —
    // it only selects which user-facing error STRING to print after
    // `Page.printToPDF` already failed over `/cdp` (browser automation has no
    // privileged transport of its own; every adapter rides `/cdp`, so there
    // is no `browser.*` capability to route this through).
    const isExtension = isExtensionRealm();
    if (isExtension) {
      return {
        stdout: '',
        stderr: 'pdf: not available in extension mode — use screenshot --full-page\n',
        exitCode: 1,
      };
    }
    return { stdout: '', stderr: `pdf: ${msg}\n`, exitCode: 1 };
  }

  return { stdout: `Saved PDF to ${savePath}\n`, stderr: '', exitCode: 0 };
};

/** Resolve a positional element ref to a clip, or a caller-facing error. */
async function resolveRefClipOrError(
  browser: BrowserAPI,
  state: PlaywrightState,
  targetId: string,
  ref: string
): Promise<{ clip: ScreenshotClip } | { error: string }> {
  const snapshot = state.snapshots.get(targetId);
  if (!snapshot) {
    throw new Error('No snapshot available. Run "snapshot" first.');
  }
  const clip = await resolveElementClip(browser, snapshot, ref);
  if (!clip || clip.width <= 0 || clip.height <= 0) {
    return {
      error:
        `could not resolve element ${ref} to a visible box — the snapshot is ` +
        'likely stale (navigation, reload, or layout change). Re-run "snapshot" and retry ' +
        'with a fresh ref, or omit the ref to capture the viewport deliberately.',
    };
  }
  return { clip };
}

const SCREENSHOT_FORMATS = new Set(['png', 'jpeg', 'webp'] as const);
type ScreenshotFormat = 'png' | 'jpeg' | 'webp';

/**
 * The capture format: explicit --type, else inferred from the --filename
 * extension, else png (matching the official CLI's inference rule).
 */
function screenshotFormat(flags: Record<string, string>): ScreenshotFormat {
  const type = flags['type'];
  if (type && SCREENSHOT_FORMATS.has(type as ScreenshotFormat)) return type as ScreenshotFormat;
  const filename = flags['filename'] ?? '';
  if (/\.jpe?g$/i.test(filename)) return 'jpeg';
  if (/\.webp$/i.test(filename)) return 'webp';
  return 'png';
}

export const screenshotHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
  scratchDir,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  if (flags['type'] && !SCREENSHOT_FORMATS.has(flags['type'] as ScreenshotFormat)) {
    return {
      stdout: '',
      stderr: `screenshot: --type must be png, jpeg, or webp, got "${flags['type']}"\n`,
      exitCode: 1,
    };
  }
  // The downscale pass reads the encoded width from the PNG IHDR; on JPEG or
  // WebP output it cannot measure the image, so it would silently return the
  // oversized original — reject loudly instead (#2405 discipline).
  if (flags['max-width'] && screenshotFormat(flags) !== 'png') {
    return {
      stdout: '',
      stderr:
        'screenshot: --max-width requires png output (the downscale pass measures PNG headers); drop --type/--filename extension or --max-width\n',
      exitCode: 1,
    };
  }
  const output = await browser.withTab(tab.targetId, async () => {
    // Ref-based screenshot: the requested element's crop or a loud failure.
    // Silently substituting the full viewport corrupts downstream visual
    // comparisons with a 0 exit code — worse than any error.
    let clip: ScreenshotClip | undefined;
    if (positional[0]?.startsWith('e')) {
      const resolved = await resolveRefClipOrError(browser, state, tab.targetId, positional[0]);
      if ('error' in resolved) return resolved;
      clip = resolved.clip;
    }

    const fullPage = flags['fullPage'] === 'true' || flags['full-page'] === 'true';
    if (flags['hires'] === 'true') {
      const { hiresClip } = await loadSnapshotFeatures();
      clip = await hiresClip(browser, clip, fullPage);
    }

    const maxWidth = flags['max-width'] ? parseInt(flags['max-width'], 10) : undefined;
    const format = screenshotFormat(flags);
    const base64 = await browser.screenshot({
      format,
      fullPage,
      ...(clip ? { clip } : {}),
      ...(maxWidth ? { maxWidth } : {}),
    });
    const extension = format === 'jpeg' ? 'jpg' : format;
    const savePath = flags['filename'] || `${scratchDir}/screenshot-${Date.now()}.${extension}`;
    const bytes = base64ToBytes(base64);
    await fs.writeFile(savePath, bytes);
    // Archive screenshot to /.playwright/screenshots/
    try {
      await ensureSessionDirs(fs, state);
      const archivePath = `/.playwright/screenshots/screenshot-${filenameSafeTimestamp(new Date())}.${extension}`;
      await fs.writeFile(archivePath, bytes);
    } catch {
      // Best-effort
    }
    const sizeKB = Math.round(bytes.length / 1024);
    return { message: `Screenshot saved to ${savePath} (${sizeKB} KB)` };
  });
  if ('error' in output) {
    return { stdout: '', stderr: `screenshot: ${output.error}\n`, exitCode: 1 };
  }
  return { stdout: output.message + '\n', stderr: '', exitCode: 0 };
};
