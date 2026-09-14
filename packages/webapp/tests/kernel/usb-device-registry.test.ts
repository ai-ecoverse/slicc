import { describe, expect, it, vi } from 'vitest';
import * as usbClaims from '../../src/kernel/usb-claim-broker.js';
import {
  DeviceHandleRegistry,
  deviceToInfo,
  type UsbClaimEvent,
  type UsbDevice,
  usbSprinkleOwner,
} from '../../src/kernel/usb-device-registry.js';
import * as usbOps from '../../src/kernel/usb-operations.js';

function fakeDevice(over: Partial<UsbDevice> = {}): UsbDevice {
  return {
    vendorId: 0x2e8a,
    productId: 0x0003,
    productName: 'RP2040',
    manufacturerName: 'Raspberry Pi',
    serialNumber: 'ABC123',
    opened: false,
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    selectConfiguration: vi.fn().mockResolvedValue(undefined),
    claimInterface: vi.fn().mockResolvedValue(undefined),
    releaseInterface: vi.fn().mockResolvedValue(undefined),
    controlTransferIn: vi.fn(),
    controlTransferOut: vi.fn(),
    transferIn: vi.fn(),
    transferOut: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
    clearHalt: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('DeviceHandleRegistry', () => {
  it('assigns stable, incrementing handles', () => {
    const reg = new DeviceHandleRegistry();
    const h1 = reg.register(fakeDevice());
    const h2 = reg.register(fakeDevice({ serialNumber: 'OTHER' }));
    expect(h1).toBe('usb1');
    expect(h2).toBe('usb2');
    expect(reg.list()).toHaveLength(2);
  });

  it('dedupes re-grants of the same device by vid/pid/serial', () => {
    const reg = new DeviceHandleRegistry();
    const h1 = reg.register(fakeDevice());
    const h2 = reg.register(fakeDevice({ opened: true }));
    expect(h2).toBe(h1);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get(h1)?.opened).toBe(true);
  });

  it('removes handles', () => {
    const reg = new DeviceHandleRegistry();
    const h = reg.register(fakeDevice());
    expect(reg.remove(h)).toBe(true);
    expect(reg.get(h)).toBeUndefined();
  });
});

describe('deviceToInfo', () => {
  it('omits optional fields that are absent', () => {
    const info = deviceToInfo('usb9', fakeDevice({ serialNumber: undefined }));
    expect(info).toEqual({
      handle: 'usb9',
      vendorId: 0x2e8a,
      productId: 0x0003,
      productName: 'RP2040',
      manufacturerName: 'Raspberry Pi',
      opened: false,
    });
  });

  it('omits `configurations` when the platform does not expose it', () => {
    expect(deviceToInfo('usb1', fakeDevice())).not.toHaveProperty('configurations');
  });

  it('flattens the descriptor tree into plain, serializable data', () => {
    // Shaped after a real Android device: interface 0 is vendor-specific,
    // interface 1 is ADB (class 0xff / subclass 0x42 / protocol 0x01).
    const info = deviceToInfo(
      'usb1',
      fakeDevice({
        configurations: [
          {
            configurationValue: 1,
            configurationName: 'default',
            interfaces: [
              {
                interfaceNumber: 1,
                claimed: false,
                alternates: [
                  {
                    alternateSetting: 0,
                    interfaceClass: 0xff,
                    interfaceSubclass: 0x42,
                    interfaceProtocol: 0x01,
                    endpoints: [
                      { endpointNumber: 3, direction: 'in', type: 'bulk', packetSize: 512 },
                      { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 512 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(info.configurations).toEqual([
      {
        configurationValue: 1,
        configurationName: 'default',
        interfaces: [
          {
            interfaceNumber: 1,
            claimed: false,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 0xff,
                interfaceSubclass: 0x42,
                interfaceProtocol: 0x01,
                endpoints: [
                  { endpointNumber: 3, direction: 'in', type: 'bulk', packetSize: 512 },
                  { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 512 },
                ],
              },
            ],
          },
        ],
      },
    ]);
    // Must survive the postMessage boundary it exists to cross.
    expect(() => structuredClone(info)).not.toThrow();
  });

  it('drops endpoints whose direction or type is outside the WebUSB vocabulary', () => {
    const info = deviceToInfo(
      'usb1',
      fakeDevice({
        configurations: [
          {
            configurationValue: 1,
            interfaces: [
              {
                interfaceNumber: 0,
                claimed: false,
                alternates: [
                  {
                    alternateSetting: 0,
                    interfaceClass: 0xff,
                    interfaceSubclass: 0xff,
                    interfaceProtocol: 0,
                    endpoints: [
                      { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
                      { endpointNumber: 2, direction: 'sideways', type: 'bulk', packetSize: 64 },
                      { endpointNumber: 3, direction: 'out', type: 'quantum', packetSize: 64 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })
    );

    expect(info.configurations?.[0]?.interfaces[0]?.alternates[0]?.endpoints).toEqual([
      { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
    ]);
  });

  it('tolerates a descriptor tree with missing nested arrays', () => {
    const info = deviceToInfo(
      'usb1',
      fakeDevice({
        configurations: [
          { configurationValue: 1, interfaces: undefined },
        ] as unknown as UsbDevice['configurations'],
      })
    );
    expect(info.configurations).toEqual([{ configurationValue: 1, interfaces: [] }]);
  });
});

describe('usb-operations', () => {
  it('lists granted devices and registers handles', async () => {
    const reg = new DeviceHandleRegistry();
    const usb = { getDevices: vi.fn().mockResolvedValue([fakeDevice()]), requestDevice: vi.fn() };
    const infos = await usbOps.usbList(reg, usb);
    expect(infos).toHaveLength(1);
    expect(infos[0].handle).toBe('usb1');
  });

  it('throws a clear error for an unknown handle', async () => {
    const reg = new DeviceHandleRegistry();
    await expect(usbOps.usbOpen(reg, 'usbX')).rejects.toThrow(/unknown usb handle 'usbX'/);
  });

  it('forwards open/claim to the device', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbOpen(reg, handle);
    await usbOps.usbClaimInterface(reg, handle, 0);
    expect(device.open).toHaveBeenCalled();
    expect(device.claimInterface).toHaveBeenCalledWith(0);
  });

  it('forwards clearHalt to the device with direction and endpoint', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClearHalt(reg, handle, 'out', 2);
    expect(device.clearHalt).toHaveBeenCalledWith('out', 2);
  });

  it('returns transfer-in bytes as an ArrayBuffer', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice({
      transferIn: vi.fn().mockResolvedValue({
        status: 'ok',
        data: { buffer: new Uint8Array([0xaa, 0xbb]).buffer, byteOffset: 0, byteLength: 2 },
      }),
    });
    const handle = reg.register(device);
    const r = await usbOps.usbTransferIn(reg, handle, 1, 64);
    expect(r.status).toBe('ok');
    expect(new Uint8Array(r.bytes)).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it('enforces the 4 MiB transfer cap', async () => {
    const reg = new DeviceHandleRegistry();
    const handle = reg.register(fakeDevice());
    await expect(usbOps.usbTransferIn(reg, handle, 1, 5 * 1024 * 1024)).rejects.toThrow(/4 MiB/);
  });
});

describe('usb-operations — two consumers on one handle', () => {
  it('refuses a second claim and names the current holder', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    const sprinkle = usbSprinkleOwner('phone-view');
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: sprinkle });
    await expect(usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell' })).rejects.toThrow(
      /held by sprinkle:phone-view/
    );
    expect(device.claimInterface).toHaveBeenCalledOnce();
  });

  it('queues a second claim until the holder releases', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    let granted = false;
    const waiting = usbOps
      .usbClaimInterface(reg, handle, 0, { owner: 'shell', wait: true })
      .then(() => {
        granted = true;
      });
    await Promise.resolve();
    expect(granted).toBe(false);
    await usbOps.usbReleaseInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    await waiting;
    expect(granted).toBe(true);
    expect(device.claimInterface).toHaveBeenCalledTimes(2);
    expect(usbClaims.claimOwner(reg, handle, 0)).toBe('shell');
  });

  it('refuses close/reset while another consumer holds a claim', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    await expect(usbOps.usbClose(reg, handle, { owner: 'shell' })).rejects.toThrow(
      /held by sprinkle:phone-view/
    );
    await expect(usbOps.usbReset(reg, handle, { owner: 'shell' })).rejects.toThrow(
      /held by sprinkle:phone-view/
    );
    expect(device.close).not.toHaveBeenCalled();
    expect(device.reset).not.toHaveBeenCalled();
  });

  it('force close displaces the holder and emits claim-lost plus disconnect', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    const events: UsbClaimEvent[] = [];
    const off = usbClaims.addClaimListener(reg, (e) => events.push(e));
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    await usbOps.usbClose(reg, handle, { owner: 'shell', force: true });
    expect(device.close).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'claim-lost',
        handle,
        interfaceNumber: 0,
        holder: 'sprinkle:phone-view',
        displacedBy: 'shell',
        reason: 'close',
      }),
      expect.objectContaining({
        type: 'disconnect',
        handle,
        holder: 'sprinkle:phone-view',
        displacedBy: 'shell',
        reason: 'close',
      }),
    ]);
    expect(usbClaims.listClaims(reg, handle)).toEqual([]);
    off();
  });

  it('lets the sole holder close without force', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell' });
    await usbOps.usbClose(reg, handle, { owner: 'shell' });
    expect(device.close).toHaveBeenCalledOnce();
    expect(usbClaims.listClaims(reg, handle)).toEqual([]);
  });

  it('allows two consumers to claim different interfaces', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    await usbOps.usbClaimInterface(reg, handle, 1, { owner: 'shell' });
    expect(usbClaims.claimOwner(reg, handle, 0)).toBe('sprinkle:phone-view');
    expect(usbClaims.claimOwner(reg, handle, 1)).toBe('shell');
    await expect(usbOps.usbReset(reg, handle, { owner: 'shell' })).rejects.toThrow(
      /interface 0 held by sprinkle:phone-view/
    );
  });

  it('cancels a queued waiter so a later release does not grant it', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    const waiting = usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell', wait: true });
    await Promise.resolve();
    await usbOps.usbCancelClaimWait(reg, handle, 0, 'shell');
    await expect(waiting).rejects.toThrow(/cancelled/);
    await usbOps.usbReleaseInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    expect(usbClaims.claimOwner(reg, handle, 0)).toBeUndefined();
    expect(device.claimInterface).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight grant so a timed-out waiter does not keep the interface', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    let finishSecond!: () => void;
    let resolveStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    device.claimInterface = vi.fn(async () => {
      resolveStarted();
      await new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
    });
    const waiting = usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell', wait: true });
    await Promise.resolve();
    await usbOps.usbReleaseInterface(reg, handle, 0, { owner: 'sprinkle:phone-view' });
    await secondStarted;
    expect(usbClaims.claimOwner(reg, handle, 0)).toBe('shell');
    await usbOps.usbCancelClaimWait(reg, handle, 0, 'shell');
    expect(usbClaims.claimOwner(reg, handle, 0)).toBeUndefined();
    finishSecond();
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(usbClaims.claimOwner(reg, handle, 0)).toBeUndefined();
    expect(device.releaseInterface).toHaveBeenCalledTimes(2);
  });

  it('does not drop a live claim when cancel arrives after the grant completed', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell' });
    await usbOps.usbCancelClaimWait(reg, handle, 0, 'shell');
    expect(usbClaims.claimOwner(reg, handle, 0)).toBe('shell');
    expect(device.releaseInterface).not.toHaveBeenCalled();
  });

  it('treats a same-owner re-claim as idempotent', async () => {
    const reg = new DeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell' });
    await usbOps.usbClaimInterface(reg, handle, 0, { owner: 'shell' });
    expect(device.claimInterface).toHaveBeenCalledTimes(2);
    expect(usbClaims.claimOwner(reg, handle, 0)).toBe('shell');
  });
});
