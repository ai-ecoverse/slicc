/**
 * Page inspection subcommands: snapshot, frames, screenshot.
 */

import type { BrowserAPI } from '../../../../cdp/index.js';
import { ensureSessionDirs } from '../session-log.js';
import { takeSnapshot } from '../snapshot.js';
import { base64ToBytes, filenameSafeTimestamp, requireTab } from '../state.js';
import type { PlaywrightHandler, TabSnapshot } from '../types.js';

type ScreenshotClip = { x: number; y: number; width: number; height: number };

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
  const { output } = await browser.withTab(tab.targetId, async () => {
    return await takeSnapshot(browser, state, tab.targetId, {
      noIframes,
    });
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
      const parent = f.parentFrameId ? ` (parent: ${f.parentFrameId})` : '';
      return `  [${type}] ${f.frameId}${parent} - ${f.url}`;
    });
    return `Frames in current tab:\n${lines.join('\n')}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const screenshotHandler: PlaywrightHandler = async ({
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
  const output = await browser.withTab(tab.targetId, async () => {
    // Ref-based screenshot
    let clip: ScreenshotClip | undefined;
    if (positional[0]?.startsWith('e')) {
      const snapshot = state.snapshots.get(tab.targetId);
      if (!snapshot) {
        throw new Error('No snapshot available. Run "snapshot" first.');
      }
      clip = await resolveElementClip(browser, snapshot, positional[0]);
    }

    const maxWidth = flags['max-width'] ? parseInt(flags['max-width'], 10) : undefined;
    const base64 = await browser.screenshot({
      fullPage: flags['fullPage'] === 'true' || flags['full-page'] === 'true',
      ...(clip ? { clip } : {}),
      ...(maxWidth ? { maxWidth } : {}),
    });
    const savePath = flags['filename'] || `/tmp/screenshot-${Date.now()}.png`;
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
    return `Screenshot saved to ${savePath} (${sizeKB} KB)`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};
