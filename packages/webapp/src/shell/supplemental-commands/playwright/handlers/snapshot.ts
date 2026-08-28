/**
 * Page inspection subcommands: snapshot, frames, screenshot.
 */

import { isExtensionRealm } from '../../../../base/runtime-env.js';
import { ensureSessionDirs } from '../session-log.js';
import { renderNode, takeSnapshot } from '../snapshot.js';
import { base64ToBytes, filenameSafeTimestamp, requireTab, resolveFrame } from '../state.js';
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

type ScreenshotClip = { x: number; y: number; width: number; height: number };

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
  return rectJson ? (JSON.parse(rectJson as string) as ScreenshotClip) : undefined;
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

export const snapshotHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  // ponytail: [target] positional arg for partial snapshots not yet wired
  const _target = positional[0];
  const noIframes = flags['no-iframes'] === 'true';
  // ponytail: depth/boxes not yet wired to injected script
  const _depth = flags['depth'] ? parseInt(flags['depth'], 10) : undefined;
  const _boxes = flags['boxes'] === 'true';
  const output = await browser.withTab(tab.targetId, async () => {
    const frame = await resolveFrame(browser, flags);
    if (frame) return takeFrameSnapshot(browser, state, tab.targetId, frame);
    const snapshot = await takeSnapshot(browser, state, tab.targetId, {
      noIframes,
    });
    return snapshot.output;
  });
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
  const output = await browser.withTab(tab.targetId, async () => {
    // Ref-based screenshot: the requested element's crop or a loud failure.
    // Silently substituting the full viewport corrupts downstream visual
    // comparisons with a 0 exit code — worse than any error.
    let clip: ScreenshotClip | undefined;
    if (positional[0]?.startsWith('e')) {
      const snapshot = state.snapshots.get(tab.targetId);
      if (!snapshot) {
        throw new Error('No snapshot available. Run "snapshot" first.');
      }
      clip = await resolveElementClip(browser, snapshot, positional[0]);
      if (!clip || clip.width <= 0 || clip.height <= 0) {
        return {
          error:
            `could not resolve element ${positional[0]} to a visible box — the snapshot is ` +
            'likely stale (navigation, reload, or layout change). Re-run "snapshot" and retry ' +
            'with a fresh ref, or omit the ref to capture the viewport deliberately.',
        };
      }
    }

    const maxWidth = flags['max-width'] ? parseInt(flags['max-width'], 10) : undefined;
    const base64 = await browser.screenshot({
      fullPage: flags['fullPage'] === 'true' || flags['full-page'] === 'true',
      ...(clip ? { clip } : {}),
      ...(maxWidth ? { maxWidth } : {}),
    });
    const savePath = flags['filename'] || `${scratchDir}/screenshot-${Date.now()}.png`;
    const bytes = base64ToBytes(base64);
    await fs.writeFile(savePath, bytes);
    // Archive screenshot to /.playwright/screenshots/
    try {
      await ensureSessionDirs(fs, state);
      const archivePath = `/.playwright/screenshots/screenshot-${filenameSafeTimestamp(new Date())}.png`;
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
