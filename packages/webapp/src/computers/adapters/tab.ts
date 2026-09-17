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
import type { TabHandle } from '../../cdp/tab-handle.js';
import type { PageInfo } from '../../cdp/types.js';
import type { PanelRpcClient } from '../../kernel/panel-rpc.js';
import type { ComputerBackend, ComputerScreenshotOpts } from '../backend.js';
import { bytesFromBase64, jpegSize } from '../encode-frame.js';
import { parseKeysym, toCdpKeyEvents } from '../keys.js';

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
      const format = opts.format === 'png' ? 'png' : 'jpeg';
      const base64 = await tab.screenshot({
        format,
        quality: format === 'jpeg' ? 70 : undefined,
        maxWidth: opts.maxWidth,
        foregroundFallback: false,
      });
      const bytes = bytesFromBase64(base64);
      const jpeg = jpegSize(bytes);
      const width = jpeg?.width ?? this.size?.width ?? 0;
      const height = jpeg?.height ?? this.size?.height ?? 0;
      if (width > 0 && height > 0) this.size = { width, height };
      this.seq += 1;
      return {
        seq: this.seq,
        mime: format === 'png' ? 'image/png' : 'image/jpeg',
        width,
        height,
        bytes,
      };
    });
  }

  async input(events: ComputerInputEvent[]): Promise<void> {
    await this.refreshInfo();
    refuseSliccAppTab({ url: this.url, title: this.title });
    await this.browser.withTab(this.targetId, async (tab) => {
      for (const event of events) await dispatchTabEvent(tab, event);
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
  title: string;
  url: string;
}

export class BridgedTabComputerBackend implements ComputerBackend {
  private seq = 0;
  private title: string;
  private url: string;
  private size: { width: number; height: number } | null = null;

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
    this.size = { width: result.width, height: result.height };
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

export async function dispatchTabEvent(tab: TabHandle, event: ComputerInputEvent): Promise<void> {
  switch (event.type) {
    case 'mousemove':
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: event.x,
        y: event.y,
      });
      return;
    case 'button':
      await dispatchButton(tab, event);
      return;
    case 'click':
      await dispatchClick(tab, event);
      return;
    case 'scroll':
      await tab.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x ?? 0,
        y: event.y ?? 0,
        deltaX: event.dx,
        deltaY: event.dy,
      });
      return;
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
  tab: TabHandle,
  event: Extract<ComputerInputEvent, { type: 'button' }>
): Promise<void> {
  await tab.send('Input.dispatchMouseEvent', {
    type: event.down ? 'mousePressed' : 'mouseReleased',
    x: event.x ?? 0,
    y: event.y ?? 0,
    button: BUTTON_NAME[event.button],
    clickCount: 1,
  });
}

async function dispatchClick(
  tab: TabHandle,
  event: Extract<ComputerInputEvent, { type: 'click' }>
): Promise<void> {
  const x = event.x ?? 0;
  const y = event.y ?? 0;
  const count = Math.max(1, event.count);
  for (let i = 1; i <= count; i++) {
    await tab.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: BUTTON_NAME[event.button],
      clickCount: i,
    });
    if (event.holdMs && event.holdMs > 0) await delay(event.holdMs);
    await tab.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: BUTTON_NAME[event.button],
      clickCount: i,
    });
  }
}

async function dispatchKey(
  tab: TabHandle,
  event: Extract<ComputerInputEvent, { type: 'key' }>
): Promise<void> {
  const parsed = parseKeysym(event.keysym);
  if (!parsed) throw new Error(`unknown keysym '${event.keysym}'`);
  for (const payload of toCdpKeyEvents(parsed, event.down)) {
    await tab.send('Input.dispatchKeyEvent', payload);
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
    const format = opts.format === 'png' ? 'png' : 'jpeg';
    const base64 = await tab.screenshot({
      format,
      quality: format === 'jpeg' ? 70 : undefined,
      maxWidth: opts.maxWidth,
      foregroundFallback: false,
    });
    const bytes = bytesFromBase64(base64);
    const jpeg = jpegSize(bytes);
    return {
      mime: format === 'png' ? 'image/png' : 'image/jpeg',
      base64,
      width: jpeg?.width ?? 0,
      height: jpeg?.height ?? 0,
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
  await browser.withTab(targetId, async (tab) => {
    for (const event of events) await dispatchTabEvent(tab, event);
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
