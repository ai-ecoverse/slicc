import { describe, expect, it, vi } from 'vitest';
import {
  DeviceHandleRegistry,
  deviceToInfo,
  type UsbDevice,
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
