/**
 * DOM-side esptool-js operations over the shared {@link SerialPortRegistry}.
 *
 * Wraps Espressif's `esptool-js` `ESPLoader` so the worker-side `esptool`
 * command (via panel-RPC) and the local-DOM backend share one
 * implementation. Ports are resolved by the same opaque handles the
 * `serial` command uses; esptool-js drives its own `Transport` over the
 * raw `SerialPort`, so any reader/writer the `serial` command left open is
 * released first. Every esptool terminal line is forwarded through the
 * `onLine` sink, which the callers turn into progress output.
 *
 * Heavy by design — only ever reached through a dynamic `import()` so
 * esptool-js (and its pako/firmware payloads) stays out of every eager
 * bundle and out of the kernel worker entirely.
 */

import { ESPLoader, type FlashOptions, type IEspLoaderTerminal, Transport } from 'esptool-js';
import type { EsptoolChipInfo, EsptoolFlashId } from './panel-rpc.js';
import type { SerialPortEntry, SerialPortRegistry } from './serial-port-registry.js';

/** A single firmware blob and its flash offset. */
export interface EsptoolFlashSegment {
  address: number;
  data: Uint8Array;
}

type TransportDevice = ConstructorParameters<typeof Transport>[0];

interface LineTerminal extends IEspLoaderTerminal {
  flush(): void;
}

/**
 * Build an `IEspLoaderTerminal` that coalesces partial `write` chunks into
 * whole lines and forwards each completed line to `onLine`.
 */
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

/** Resolve a registered port and release any `serial`-held locks so esptool can open it. */
async function takeOverPort(
  registry: SerialPortRegistry,
  handle: string
): Promise<SerialPortEntry> {
  const entry = registry.get(handle);
  if (!entry) throw new Error(`unknown serial handle '${handle}'`);
  if (entry.reader) {
    try {
      await entry.reader.cancel();
    } catch {
      /* reader may already be closed */
    }
    try {
      entry.reader.releaseLock();
    } catch {
      /* lock may already be released */
    }
    entry.reader = undefined;
  }
  if (entry.writer) {
    try {
      entry.writer.releaseLock();
    } catch {
      /* lock may already be released */
    }
    entry.writer = undefined;
  }
  entry.pendingRead = undefined;
  entry.leftover = undefined;
  if (entry.opened) {
    try {
      await entry.port.close();
    } catch {
      /* may already be closed */
    }
    entry.opened = false;
  }
  return entry;
}

/**
 * Connect to the chip, run `body`, then hard-reset and disconnect. esptool
 * `main()` detects the chip, uploads the flasher stub, and switches baud,
 * so `body` runs with a stub-backed loader ready for chip/flash ops.
 */
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
    } catch {
      /* best-effort reset */
    }
    try {
      await transport.disconnect();
    } catch {
      /* best-effort teardown */
    }
    terminal.flush();
  }
}

/** Detect the chip and read its identity (variant, features, crystal, MAC). */
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

/** Read just the factory MAC address. */
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

/** Erase the entire flash. */
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

/** Flash one or more firmware segments, streaming `Writing at 0x…` lines via `onLine`. */
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

/** Read `size` bytes from flash starting at `address`. Streams `Reading flash…` progress via `onLine`. */
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

/** Read a single 32-bit register value at `address`. */
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

/** Read SPI flash manufacturer / device id + detected size from the RDID command. */
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

/**
 * Erase a flash region (`address` + `size`, both aligned to a 4 KiB
 * sector by the bootloader). esptool-js doesn't expose a high-level
 * `eraseRegion`, so this drives the raw `ESP_ERASE_REGION = 0xd1`
 * opcode via `checkCommand`, packing two little-endian uint32 values
 * just like Python `esptool.py`.
 */
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

/**
 * Leave the bootloader and run the application. `withLoader` already
 * issues a `hard_reset` in its `finally` block, so the body is empty —
 * the connect/stub-upload roundtrip plus the post-body reset is exactly
 * what Python esptool's `run` verb does.
 */
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
