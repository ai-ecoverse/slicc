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
import type { EsptoolChipInfo } from './panel-rpc.js';
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
