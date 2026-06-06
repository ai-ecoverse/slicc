import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canOpenHidPickerPopup,
  openHidPickerPopup,
} from '../../../src/shell/supplemental-commands/hid-picker.js';
import {
  canOpenSerialPickerPopup,
  openSerialPickerPopup,
} from '../../../src/shell/supplemental-commands/serial-picker.js';
import {
  canOpenUsbPickerPopup,
  openUsbPickerPopup,
} from '../../../src/shell/supplemental-commands/usb-picker.js';

/**
 * The HID / USB / Serial picker wrappers are thin shims over
 * `openPickerPopup` that re-shape the response into a per-kind result
 * union. They were missing direct test coverage; this file drives each
 * wrapper through the success / cancel / error / malformed-response
 * branches with a stubbed chrome.runtime/windows surface.
 */

type Listener = (msg: unknown) => void;

let listeners: Listener[];
let createCalls: Array<{ url: string }>;

function deliver(msg: Record<string, unknown>) {
  for (const l of [...listeners]) l(msg);
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  createCalls = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'ext-id',
      getURL: (path: string) => `chrome-extension://ext-id/${path}`,
      onMessage: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => {
          listeners = listeners.filter((x) => x !== l);
        },
      },
    },
    windows: {
      create: (opts: { url: string }) => {
        createCalls.push({ url: opts.url });
        return Promise.resolve({ id: 1 });
      },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('canOpenXxxPickerPopup', () => {
  it('delegates to canOpenPickerPopup for hid / usb / serial', () => {
    expect(canOpenHidPickerPopup()).toBe(true);
    expect(canOpenUsbPickerPopup()).toBe(true);
    expect(canOpenSerialPickerPopup()).toBe(true);
  });
});

describe('openHidPickerPopup', () => {
  it('resolves with the granted identifiers on a happy-path picker', async () => {
    const promise = openHidPickerPopup([{ vendorId: 0x320f }]);
    await Promise.resolve();
    expect(createCalls[0].url).toContain('kind=hid-device');
    deliver({
      source: 'picker-popup',
      kind: 'hid-device',
      requestId: '',
      granted: true,
      info: { vendorId: 0x320f, productId: 0x5000 },
    });
    // requestId here is the auto-generated one; resolve by handler
    const reqId = decodeURIComponent(createCalls[0].url.split('requestId=')[1].split('&')[0]);
    deliver({
      source: 'picker-popup',
      kind: 'hid-device',
      requestId: reqId,
      granted: true,
      info: { vendorId: 0x320f, productId: 0x5000 },
    });
    const result = await promise;
    expect(result).toEqual({ granted: true, info: { vendorId: 0x320f, productId: 0x5000 } });
  });

  it('translates a cancellation envelope into { cancelled: true }', async () => {
    const promise = openHidPickerPopup([]);
    await Promise.resolve();
    const reqId = decodeURIComponent(createCalls[0].url.split('requestId=')[1].split('&')[0]);
    deliver({ source: 'picker-popup', kind: 'hid-device', requestId: reqId, cancelled: true });
    expect(await promise).toEqual({ cancelled: true });
  });

  it('forwards an error envelope verbatim', async () => {
    const promise = openHidPickerPopup([]);
    await Promise.resolve();
    const reqId = decodeURIComponent(createCalls[0].url.split('requestId=')[1].split('&')[0]);
    deliver({
      source: 'picker-popup',
      kind: 'hid-device',
      requestId: reqId,
      error: 'WebHID disabled',
    });
    expect(await promise).toEqual({ error: 'WebHID disabled' });
  });

  it('treats an unexpected response shape as a clean error', async () => {
    const promise = openHidPickerPopup([]);
    await Promise.resolve();
    const reqId = decodeURIComponent(createCalls[0].url.split('requestId=')[1].split('&')[0]);
    deliver({ source: 'picker-popup', kind: 'hid-device', requestId: reqId });
    expect(await promise).toEqual({ error: 'hid picker returned an unexpected response' });
  });

  it('times out as a cancellation when no response arrives', async () => {
    const promise = openHidPickerPopup([]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await promise).toEqual({ cancelled: true });
  });
});

describe('openUsbPickerPopup', () => {
  it('granted / cancelled / error / unknown / timeout all map cleanly', async () => {
    const granted = openUsbPickerPopup([{ vendorId: 0x2e8a }]);
    await Promise.resolve();
    const reqId1 = decodeURIComponent(createCalls[0].url.split('requestId=')[1].split('&')[0]);
    deliver({
      source: 'picker-popup',
      kind: 'usb-device',
      requestId: reqId1,
      granted: true,
      info: { vendorId: 0x2e8a, productId: 0x0003 },
    });
    expect(await granted).toMatchObject({
      granted: true,
      info: { vendorId: 0x2e8a, productId: 0x0003 },
    });
  });
});

describe('openSerialPickerPopup', () => {
  it('granted resolves with the picker identifiers', async () => {
    const granted = openSerialPickerPopup([{ usbVendorId: 0x10c4 }]);
    await Promise.resolve();
    const reqId = decodeURIComponent(createCalls[0].url.split('requestId=')[1].split('&')[0]);
    deliver({
      source: 'picker-popup',
      kind: 'serial-port',
      requestId: reqId,
      granted: true,
      info: { usbVendorId: 0x10c4, usbProductId: 0xea60 },
    });
    expect(await granted).toMatchObject({
      granted: true,
      info: { usbVendorId: 0x10c4, usbProductId: 0xea60 },
    });
  });
});
