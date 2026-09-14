import { ESPLoader, type FlashOptions, type IEspLoaderTerminal, Transport } from 'esptool-js';
import type { EsptoolChipInfo, EsptoolFlashId } from './panel-rpc.js';
import type { SerialPortEntry, SerialPortRegistry } from './serial-port-registry.js';

export interface EsptoolFlashSegment {
  address: number;
  data: Uint8Array;
}

type TransportDevice = ConstructorParameters<typeof Transport>[0];

interface LineTerminal extends IEspLoaderTerminal {
  flush(): void;
}

function makeTerminal(onLine: (line: string) => void): LineTerminal {
  let pending = '';
  return {
    clean() {
      pending = '';
    },
    write(data: string) {
      pending += data;
    },
    writeLine(data: string) {
      onLine(pending + data);
      pending = '';
    },
    flush() {
      if (pending) {
        onLine(pending);
        pending = '';
      }
    },
  };
}

async function takeOverPort(
  registry: SerialPortRegistry,
  handle: string
): Promise<SerialPortEntry> {
  const entry = registry.get(handle);
  if (!entry) throw new Error(`unknown serial handle '${handle}'`);
  if (entry.reader) {
    try {
      await entry.reader.cancel();
    } catch {}
    try {
      entry.reader.releaseLock();
    } catch {}
    entry.reader = undefined;
  }
  if (entry.writer) {
    try {
      entry.writer.releaseLock();
    } catch {}
    entry.writer = undefined;
  }
  entry.pendingRead = undefined;
  entry.leftover = undefined;
  if (entry.opened) {
    try {
      await entry.port.close();
    } catch {}
    entry.opened = false;
  }
  return entry;
}

async function withLoader<T>(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  onLine: (line: string) => void,
  body: (loader: ESPLoader) => Promise<T>
): Promise<T> {
  const entry = await takeOverPort(registry, handle);
  const terminal = makeTerminal(onLine);
  const transport = new Transport(entry.port as unknown as TransportDevice, false);
  const loader = new ESPLoader({ transport, baudrate: baudRate, terminal, debugLogging: false });
  try {
    await loader.main();
    return await body(loader);
  } finally {
    try {
      await loader.after('hard_reset');
    } catch {}
    try {
      await transport.disconnect();
    } catch {}
    terminal.flush();
  }
}

export async function esptoolChipInfo(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  onLine: (line: string) => void
): Promise<EsptoolChipInfo> {
  return withLoader(registry, handle, baudRate, onLine, async (loader) => ({
    chip: loader.chip.CHIP_NAME,
    description: await loader.chip.getChipDescription(loader),
    features: await loader.chip.getChipFeatures(loader),
    crystalMHz: await loader.chip.getCrystalFreq(loader),
    mac: await loader.chip.readMac(loader),
  }));
}

export async function esptoolReadMac(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  onLine: (line: string) => void
): Promise<{ mac: string }> {
  return withLoader(registry, handle, baudRate, onLine, async (loader) => ({
    mac: await loader.chip.readMac(loader),
  }));
}

export async function esptoolEraseFlash(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  onLine: (line: string) => void
): Promise<void> {
  await withLoader(registry, handle, baudRate, onLine, async (loader) => {
    await loader.eraseFlash();
  });
}

export async function esptoolFlash(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  eraseAll: boolean,
  segments: EsptoolFlashSegment[],
  onLine: (line: string) => void
): Promise<void> {
  await withLoader(registry, handle, baudRate, onLine, async (loader) => {
    const flashOptions: FlashOptions = {
      fileArray: segments.map((s) => ({ data: s.data, address: s.address })),
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll,
      compress: true,
    };
    await loader.writeFlash(flashOptions);
  });
}

export async function esptoolReadFlash(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  address: number,
  size: number,
  onLine: (line: string) => void
): Promise<Uint8Array> {
  return withLoader(registry, handle, baudRate, onLine, async (loader) => {
    let lastPct = -1;
    return loader.readFlash(address, size, (_packet, progress, totalSize) => {
      const pct = totalSize > 0 ? Math.floor((progress / totalSize) * 100) : 100;
      if (pct !== lastPct) {
        lastPct = pct;
        onLine(`Reading flash at 0x${address.toString(16)}... (${pct}%)`);
      }
    });
  });
}

export async function esptoolReadReg(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  address: number,
  onLine: (line: string) => void
): Promise<{ value: number }> {
  return withLoader(registry, handle, baudRate, onLine, async (loader) => ({
    value: (await loader.readReg(address)) >>> 0,
  }));
}

export async function esptoolFlashId(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  onLine: (line: string) => void
): Promise<EsptoolFlashId> {
  return withLoader(registry, handle, baudRate, onLine, async (loader) => {
    const flashId = (await loader.readFlashId()) >>> 0;
    const manufacturer = flashId & 0xff;
    const device = ((flashId >> 8) & 0xff) | ((flashId >> 16) & 0xff00);
    const sizeId = (flashId >> 16) & 0xff;
    const sizes = (loader as unknown as { DETECTED_FLASH_SIZES: Record<number, string> })
      .DETECTED_FLASH_SIZES;
    const flashSize = sizes[sizeId] ?? null;
    return { flashId, manufacturer, device, flashSize };
  });
}

export async function esptoolEraseRegion(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  address: number,
  size: number,
  onLine: (line: string) => void
): Promise<void> {
  await withLoader(registry, handle, baudRate, onLine, async (loader) => {
    const pkt = new Uint8Array(8);
    const dv = new DataView(pkt.buffer);
    dv.setUint32(0, address >>> 0, true);
    dv.setUint32(4, size >>> 0, true);
    onLine(`Erasing region 0x${address.toString(16)} (${size} bytes)...`);
    await loader.checkCommand('erase region', loader.ESP_ERASE_REGION, pkt);
  });
}

export async function esptoolRun(
  registry: SerialPortRegistry,
  handle: string,
  baudRate: number,
  onLine: (line: string) => void
): Promise<void> {
  await withLoader(registry, handle, baudRate, onLine, async () => {
    onLine('Leaving bootloader; running app...');
  });
}
