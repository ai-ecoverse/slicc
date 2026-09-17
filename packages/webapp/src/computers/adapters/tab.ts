/**
 * Browser-tab computer backend. Local path talks to `BrowserAPI` (CLI
 * kernel / page handlers). Bridged path forwards screenshot + input
 * over panel-RPC so the kernel worker stays DOM-free (HID-style).
 */

import type {
  ComputerCapabilities,
  ComputerDescriptor,
  ComputerFrame,
  ComputerInputEvent,
  ComputerMouseButton,
} from '@slicc/shared-ts';
import { isSliccAppUrl } from '@slicc/shared-ts';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import type { TabPage } from '../../cdp/tab-handle.js';
import type { PageInfo } from '../../cdp/types.js';
import type { PanelRpcClient } from '../../kernel/panel-rpc.js';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';
import { base64FromBytes, bytesFromBase64, jpegSize, pngSize } from '../encode-frame.js';
import { parseKeysym, toCdpKeyEvents } from '../keys.js';
import { createPointer, resolvePointer } from '../pointer.js';

export function tabComputerId(targetId: string): string {
  return `tab:${targetId}`;
}

const CAPABILITIES: ComputerCapabilities = {
  screenshot: true,
  text: false,
  frames: 'poll',
  keyboard: true,
  mouse: 'absolute',
  scroll: true,
  exec: false,
  inputAllowed: true,
};

const BUTTON_NAME: Record<ComputerMouseButton, 'left' | 'middle' | 'right'> = {
  1: 'left',
  2: 'middle',
  3: 'right',
};

export function refuseSliccAppTab(info: { url: string; title?: string }): void {
  if (isSliccAppUrl(info.url)) {
    throw new Error(`refusing SLICC app tab '${info.title ?? info.url}'`);
  }
}

export class LocalTabComputerBackend implements ComputerBackend {
  private seq = 0;
  private title: string;
  private url: string;
  private size: { width: number; height: number } | null = null;
  private readonly pointer = createPointer();

  constructor(
    private readonly browser: BrowserAPI,
    readonly targetId: string,
    info: { title: string; url: string } = { title: targetId, url: '' }
  ) {
    this.title = info.title;
    this.url = info.url;
  }

  describe(): ComputerDescriptor {
    return {
      id: tabComputerId(this.targetId),
      kind: 'tab',
      title: this.title,
      size: this.size,
      state: 'live',
      capabilities: CAPABILITIES,
      pid: null,
    };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    await this.refreshInfo();
    refuseSliccAppTab({ url: this.url, title: this.title });
    return this.browser.withTab(this.targetId, async (tab) => {
      const captured = await captureTabFrame(tab, opts);
      if (captured.native) this.size = captured.native;
      this.seq += 1;
      return {
        seq: this.seq,
        mime: captured.mime,
        width: captured.width,
        height: captured.height,
        bytes: captured.bytes,
      };
    });
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    await this.refreshInfo();
    refuseSliccAppTab({ url: this.url, title: this.title });
    await this.browser.withTab(this.targetId, async (tab) => {
      for (const event of events) await dispatchTabEvent(tab, event, this.pointer);
    });
  }

  async close(): Promise<void> {
    // The tab stays open — `computer rm` only drops the registry entry.
  }

  private async refreshInfo(): Promise<void> {
    const hit = await lookupTarget(this.browser, this.targetId);
    if (!hit) return;
    this.title = hit.title || this.title;
    this.url = hit.url || this.url;
  }
}

export interface TabShotResult {
  mime: 'image/png' | 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  nativeWidth?: number;
  nativeHeight?: number;
  title: string;
  url: string;
}

interface CapturedTabFrame {
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
  native: { width: number; height: number } | null;
}

async function captureTabFrame(
  tab: TabPage,
  opts: ComputerScreenshotOpts
): Promise<CapturedTabFrame> {
  const nativeB64 = await tab.screenshot({ format: 'png' });
  const nativeBytes = bytesFromBase64(nativeB64);
  const native = pngSize(nativeBytes) ?? jpegSize(nativeBytes);
  let shotBytes = nativeBytes;
  if (opts.maxWidth && native && native.width > opts.maxWidth) {
    shotBytes = bytesFromBase64(await tab.screenshot({ format: 'png', maxWidth: opts.maxWidth }));
  } else if (opts.format !== 'png') {
    shotBytes = bytesFromBase64(await tab.screenshot({ format: 'jpeg', quality: 70 }));
  }
  const encoded = pngSize(shotBytes) ?? jpegSize(shotBytes) ?? native ?? { width: 0, height: 0 };
  const jpeg = jpegSize(shotBytes);
  return {
    mime: jpeg ? 'image/jpeg' : 'image/png',
    bytes: shotBytes,
    width: encoded.width,
    height: encoded.height,
    native,
  };
}

export class BridgedTabComputerBackend implements ComputerBackend {
  private seq = 0;
  private title: string;
  private url: string;
  private size: { width: number; height: number } | null = null;
  private readonly pointer = createPointer();

  constructor(
    private readonly rpc: PanelRpcClient,
    readonly targetId: string,
    info: { title: string; url: string } = { title: targetId, url: '' }
  ) {
    this.title = info.title;
    this.url = info.url;
  }

  describe(): ComputerDescriptor {
    return {
      id: tabComputerId(this.targetId),
      kind: 'tab',
      title: this.title,
      size: this.size,
      state: 'live',
      capabilities: CAPABILITIES,
      pid: null,
    };
  }

  async screenshot(opts: ComputerScreenshotOpts): Promise<ComputerFrame> {
    const result = await this.rpc.call('computer-tab-screenshot', {
      targetId: this.targetId,
      maxWidth: opts.maxWidth,
      format: opts.format,
    });
    this.title = result.title;
    this.url = result.url;
    if (result.nativeWidth && result.nativeHeight) {
      this.size = { width: result.nativeWidth, height: result.nativeHeight };
    } else {
      this.size = { width: result.width, height: result.height };
    }
    this.seq += 1;
    return {
      seq: this.seq,
      mime: result.mime,
      width: result.width,
      height: result.height,
      bytes: bytesFromBase64(result.base64),
    };
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    await this.rpc.call('computer-tab-input', { targetId: this.targetId, events });
  }

  async close(): Promise<void> {
    // Detach only.
  }
}

export async function dispatchTabEvent(
  tab: TabPage,
  event: ComputerInputEvent,
  pointer = createPointer()
): Promise<void> {
  switch (event.type) {
    case 'mousemove': {
      const p = resolvePointer(pointer, event);
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: p.x,
        y: p.y,
      });
      return;
    }
    case 'button':
      await dispatchButton(tab, event, pointer);
      return;
    case 'click':
      await dispatchClick(tab, event, pointer);
      return;
    case 'drag':
      await dispatchDrag(tab, event, pointer);
      return;
    case 'scroll': {
      const p = resolvePointer(pointer, event);
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: p.x,
        y: p.y,
        deltaX: event.dx,
        deltaY: event.dy,
      });
      return;
    }
    case 'key':
      await dispatchKey(tab, event);
      return;
    case 'text':
      await tab.send('Input.insertText', { text: event.text });
      return;
    case 'wait':
      await delay(Math.max(0, event.ms));
      return;
    default: {
      const _never: never = event;
      void _never;
    }
  }
}

async function dispatchButton(
  tab: TabPage,
  event: Extract<ComputerInputEvent, { type: 'button' }>,
  pointer: ReturnType<typeof createPointer>
): Promise<void> {
  const p = resolvePointer(pointer, event);
  await tab.send('Input.dispatchMouseEvent', {
    type: event.down ? 'mousePressed' : 'mouseReleased',
    x: p.x,
    y: p.y,
    button: BUTTON_NAME[event.button],
    clickCount: 1,
  });
}

async function dispatchClick(
  tab: TabPage,
  event: Extract<ComputerInputEvent, { type: 'click' }>,
  pointer: ReturnType<typeof createPointer>
): Promise<void> {
  const p = resolvePointer(pointer, event);
  const count = Math.max(1, event.count);
  for (let i = 1; i <= count; i++) {
    await tab.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button: BUTTON_NAME[event.button],
      clickCount: i,
    });
    if (event.holdMs && event.holdMs > 0) await delay(event.holdMs);
    await tab.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button: BUTTON_NAME[event.button],
      clickCount: i,
    });
  }
}

async function dispatchDrag(
  tab: TabPage,
  event: Extract<ComputerInputEvent, { type: 'drag' }>,
  pointer: ReturnType<typeof createPointer>
): Promise<void> {
  await dispatchTabEvent(tab, { type: 'mousemove', x: event.x1, y: event.y1 }, pointer);
  await dispatchTabEvent(
    tab,
    { type: 'button', button: 1, down: true, x: event.x1, y: event.y1 },
    pointer
  );
  await dispatchTabEvent(tab, { type: 'mousemove', x: event.x2, y: event.y2 }, pointer);
  await dispatchTabEvent(
    tab,
    { type: 'button', button: 1, down: false, x: event.x2, y: event.y2 },
    pointer
  );
}

async function dispatchKey(
  tab: TabPage,
  event: Extract<ComputerInputEvent, { type: 'key' }>
): Promise<void> {
  const parsed = parseKeysym(event.keysym);
  if (!parsed) throw new Error(`unknown keysym '${event.keysym}'`);
  for (const payload of toCdpKeyEvents(parsed, event.down)) {
    await tab.send('Input.dispatchKeyEvent', {
      type: payload.type,
      key: payload.key,
      code: payload.code,
      modifiers: payload.modifiers,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
    });
  }
}

export async function screenshotTab(
  browser: BrowserAPI,
  targetId: string,
  opts: { maxWidth?: number; format?: 'png' | 'jpeg' }
): Promise<TabShotResult> {
  const info = (await lookupTarget(browser, targetId)) ?? { title: targetId, url: '' };
  refuseSliccAppTab(info);
  return browser.withTab(targetId, async (tab) => {
    const captured = await captureTabFrame(tab, {
      format: opts.format === 'png' ? 'png' : 'jpeg',
      maxWidth: opts.maxWidth,
    });
    return {
      mime: captured.mime,
      base64: base64FromBytes(captured.bytes),
      width: captured.width,
      height: captured.height,
      ...(captured.native
        ? { nativeWidth: captured.native.width, nativeHeight: captured.native.height }
        : {}),
      title: info.title,
      url: info.url,
    };
  });
}

export async function inputTab(
  browser: BrowserAPI,
  targetId: string,
  events: ComputerInputEvent[]
): Promise<void> {
  const info = (await lookupTarget(browser, targetId)) ?? { title: targetId, url: '' };
  refuseSliccAppTab(info);
  const pointer = createPointer();
  await browser.withTab(targetId, async (tab) => {
    for (const event of events) await dispatchTabEvent(tab, event, pointer);
  });
}

export function resolveTabPage(pages: PageInfo[], spec: string): PageInfo | { error: string } {
  const exact = pages.find((p) => p.targetId === spec);
  if (exact) return exact;
  const urlHits = pages.filter((p) => p.url === spec || p.url.startsWith(spec));
  if (urlHits.length === 1) return urlHits[0];
  if (urlHits.length > 1) {
    return { error: `ambiguous url '${spec}' matches ${urlHits.length} tabs` };
  }
  const titleHits = pages.filter((p) => p.title === spec);
  if (titleHits.length === 1) return titleHits[0];
  return { error: `no tab matching '${spec}'` };
}

async function lookupTarget(
  browser: BrowserAPI,
  targetId: string
): Promise<{ title: string; url: string } | null> {
  const pages = await browser.listAllTargets();
  const hit = pages.find((p) => p.targetId === targetId);
  return hit ? { title: hit.title, url: hit.url } : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
