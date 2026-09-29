// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const surfaceMock = vi.hoisted(() => ({
  request: vi.fn(),
  prompt: vi.fn(),
}));

const surfaceHolder = vi.hoisted(() => ({ value: surfaceMock as typeof surfaceMock | null }));

vi.mock('../../src/ui/wc/wc-permissions-registry.js', () => ({
  getLeaderPermissionsSurface: () => surfaceHolder.value,
}));

const navMocks = vi.hoisted(() => ({
  usbRequestDevice: vi.fn(),
  hidRequestDevice: vi.fn(),
  serialRequestPort: vi.fn(),
  usbGetDevices: vi.fn(async () => []),
  hidGetDevices: vi.fn(async () => []),
  serialGetPorts: vi.fn(async () => []),
}));

vi.mock('../../src/kernel/usb-device-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/kernel/usb-device-registry.js')>();
  return {
    ...actual,
    getNavigatorUsb: () => ({
      getDevices: navMocks.usbGetDevices,
      requestDevice: navMocks.usbRequestDevice,
    }),
  };
});

vi.mock('../../src/kernel/hid-device-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/kernel/hid-device-registry.js')>();
  return {
    ...actual,
    getNavigatorHid: () => ({
      getDevices: navMocks.hidGetDevices,
      requestDevice: navMocks.hidRequestDevice,
    }),
  };
});

vi.mock('../../src/kernel/serial-port-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/kernel/serial-port-registry.js')>();
  return {
    ...actual,
    getNavigatorSerial: () => ({
      getPorts: navMocks.serialGetPorts,
      requestPort: navMocks.serialRequestPort,
    }),
  };
});

const { mountDip } = await import('../../src/ui/dip.js');

function postFromDip(iframe: HTMLIFrameElement, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', { source: iframe.contentWindow as Window, data })
  );
}

async function awaitResponse(
  postSpy: ReturnType<typeof vi.fn>,
  predicate: (msg: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    const hit = postSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((m) => predicate(m));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('timed out waiting for dip-device-op-response');
}

describe('trusted dip device request Grant wrap (#3631)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    surfaceHolder.value = surfaceMock;
    surfaceMock.request.mockReset();
    surfaceMock.prompt.mockReset();
    for (const fn of Object.values(navMocks)) fn.mockReset();
    navMocks.usbGetDevices.mockResolvedValue([]);
    navMocks.hidGetDevices.mockResolvedValue([]);
    navMocks.serialGetPorts.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('routes usb request through surface.prompt (not raw requestDevice)', async () => {
    const device = {
      vendorId: 0x2341,
      productId: 1,
      productName: 'Arduino',
      manufacturerName: 'Arduino',
      serialNumber: 'x',
      opened: false,
      configuration: null,
      configurations: [],
      open: vi.fn(),
      close: vi.fn(),
    };
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'usb', device }],
    });

    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-device-op',
      id: 11,
      channel: 'usb',
      op: 'request',
      args: [[{ vendorId: 0x2341 }]],
    });

    const response = await awaitResponse(
      postSpy,
      (m) => m.type === 'dip-device-op-response' && m.id === 11
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(expect.objectContaining({ vendorId: 0x2341 }));
    expect(surfaceMock.prompt).toHaveBeenCalledWith({
      kinds: ['usb'],
      description: 'A sprinkle or dip asks to use a USB device.',
      requestOptions: { usb: { filters: [{ vendorId: 0x2341 }] } },
    });
    expect(surfaceMock.request).not.toHaveBeenCalled();
    expect(navMocks.usbRequestDevice).not.toHaveBeenCalled();
    inst.dispose();
  });

  it('routes hid request through prompt and returns every granted interface', async () => {
    const devices = [
      {
        vendorId: 0x320f,
        productId: 0x5000,
        productName: 'KB',
        collections: [],
        opened: false,
        open: vi.fn(),
        close: vi.fn(),
        sendReport: vi.fn(),
        sendFeatureReport: vi.fn(),
        receiveFeatureReport: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    ];
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'hid', device: devices[0], devices }],
    });

    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-device-op',
      id: 12,
      channel: 'hid',
      op: 'request',
      args: [[]],
    });

    const response = await awaitResponse(
      postSpy,
      (m) => m.type === 'dip-device-op-response' && m.id === 12
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(
      expect.arrayContaining([expect.objectContaining({ vendorId: 0x320f })])
    );
    expect(surfaceMock.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kinds: ['hid'],
        description: 'A sprinkle or dip asks to use a HID device.',
      })
    );
    expect(navMocks.hidRequestDevice).not.toHaveBeenCalled();
    inst.dispose();
  });

  it('routes serial request through prompt with filters', async () => {
    const port = {
      getInfo: () => ({ usbVendorId: 0x2e8a }),
      open: vi.fn(),
      close: vi.fn(),
      readable: null,
      writable: null,
    };
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'serial', port }],
    });

    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-device-op',
      id: 13,
      channel: 'serial',
      op: 'request',
      args: [[{ usbVendorId: 0x2e8a }]],
    });

    const response = await awaitResponse(
      postSpy,
      (m) => m.type === 'dip-device-op-response' && m.id === 13
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(expect.objectContaining({ handle: expect.any(String) }));
    expect(surfaceMock.prompt).toHaveBeenCalledWith({
      kinds: ['serial'],
      description: 'A sprinkle or dip asks to use a serial port.',
      requestOptions: { serial: { filters: [{ usbVendorId: 0x2e8a }] } },
    });
    expect(navMocks.serialRequestPort).not.toHaveBeenCalled();
    inst.dispose();
  });

  it('rejects usb request when the user cancels the Grant prompt', async () => {
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'cancelled',
      grants: [],
      reason: 'cancelled',
    });

    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-device-op',
      id: 14,
      channel: 'usb',
      op: 'request',
      args: [[]],
    });

    const response = await awaitResponse(
      postSpy,
      (m) => m.type === 'dip-device-op-response' && m.id === 14
    );
    expect(response.error).toBe('usb request cancelled');
    expect(navMocks.usbRequestDevice).not.toHaveBeenCalled();
    inst.dispose();
  });

  it('rejects device ops from an untrusted dip even if the message is spoofed', async () => {
    const inst = mountDip(container, '<button>x</button>', vi.fn(), false);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-device-op',
      id: 15,
      channel: 'usb',
      op: 'request',
      args: [[]],
    });

    const response = await awaitResponse(
      postSpy,
      (m) => m.type === 'dip-device-op-response' && m.id === 15
    );
    expect(response.error).toBe('device access not allowed for this dip');
    expect(surfaceMock.prompt).not.toHaveBeenCalled();
    inst.dispose();
  });

  it('falls back to navigator pickers when no permissions surface is mounted', async () => {
    surfaceHolder.value = null;
    const device = {
      vendorId: 1,
      productId: 2,
      productName: 'Dev',
      manufacturerName: 'T',
      serialNumber: 's',
      opened: false,
      configuration: null,
      configurations: [],
      open: vi.fn(),
      close: vi.fn(),
    };
    navMocks.usbRequestDevice.mockResolvedValueOnce(device);

    const inst = mountDip(container, '<button>x</button>', vi.fn(), true);
    const iframe = container.querySelector('iframe')!;
    const postSpy = vi.fn();
    Object.defineProperty(iframe.contentWindow!, 'postMessage', {
      configurable: true,
      value: postSpy,
    });

    postFromDip(iframe, {
      type: 'dip-device-op',
      id: 16,
      channel: 'usb',
      op: 'request',
      args: [[{ vendorId: 1 }]],
    });

    const response = await awaitResponse(
      postSpy,
      (m) => m.type === 'dip-device-op-response' && m.id === 16
    );
    expect(response.error).toBeUndefined();
    expect(navMocks.usbRequestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 1 }] });
    expect(surfaceMock.prompt).not.toHaveBeenCalled();
    inst.dispose();
  });
});
