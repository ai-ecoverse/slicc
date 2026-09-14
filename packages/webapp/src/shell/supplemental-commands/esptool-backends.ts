import type {
  EsptoolChipInfo,
  EsptoolFlashId,
  EsptoolProgressEventPayload,
  PanelRpcClient,
} from '../../kernel/panel-rpc.js';
import { getNavigatorSerial, getSharedSerialRegistry } from '../../kernel/serial-port-registry.js';

export interface EsptoolFlashSegment {
  address: number;
  data: Uint8Array;
}

export type EsptoolLineSink = (line: string) => void;

export interface EsptoolBackend {
  chipInfo(handle: string, baudRate: number, onLine: EsptoolLineSink): Promise<EsptoolChipInfo>;
  readMac(handle: string, baudRate: number, onLine: EsptoolLineSink): Promise<{ mac: string }>;
  eraseFlash(handle: string, baudRate: number, onLine: EsptoolLineSink): Promise<void>;
  flash(
    handle: string,
    baudRate: number,
    eraseAll: boolean,
    segments: EsptoolFlashSegment[],
    onLine: EsptoolLineSink
  ): Promise<void>;
  readFlash(
    handle: string,
    baudRate: number,
    address: number,
    size: number,
    onLine: EsptoolLineSink
  ): Promise<Uint8Array>;
  readReg(
    handle: string,
    baudRate: number,
    address: number,
    onLine: EsptoolLineSink
  ): Promise<{ value: number }>;
  flashId(handle: string, baudRate: number, onLine: EsptoolLineSink): Promise<EsptoolFlashId>;
  eraseRegion(
    handle: string,
    baudRate: number,
    address: number,
    size: number,
    onLine: EsptoolLineSink
  ): Promise<void>;
  run(handle: string, baudRate: number, onLine: EsptoolLineSink): Promise<void>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

class LocalEsptoolBackend implements EsptoolBackend {
  private ops() {
    return import('../../kernel/esptool-operations.js');
  }
  private registry() {
    if (!getNavigatorSerial()) throw new Error('Web Serial is unavailable in this browser');
    return getSharedSerialRegistry();
  }
  async chipInfo(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    return (await this.ops()).esptoolChipInfo(this.registry(), handle, baudRate, onLine);
  }
  async readMac(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    return (await this.ops()).esptoolReadMac(this.registry(), handle, baudRate, onLine);
  }
  async eraseFlash(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    await (await this.ops()).esptoolEraseFlash(this.registry(), handle, baudRate, onLine);
  }
  async flash(
    handle: string,
    baudRate: number,
    eraseAll: boolean,
    segments: EsptoolFlashSegment[],
    onLine: EsptoolLineSink
  ) {
    await (await this.ops()).esptoolFlash(
      this.registry(),
      handle,
      baudRate,
      eraseAll,
      segments,
      onLine
    );
  }
  async readFlash(
    handle: string,
    baudRate: number,
    address: number,
    size: number,
    onLine: EsptoolLineSink
  ) {
    return (await this.ops()).esptoolReadFlash(
      this.registry(),
      handle,
      baudRate,
      address,
      size,
      onLine
    );
  }
  async readReg(handle: string, baudRate: number, address: number, onLine: EsptoolLineSink) {
    return (await this.ops()).esptoolReadReg(this.registry(), handle, baudRate, address, onLine);
  }
  async flashId(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    return (await this.ops()).esptoolFlashId(this.registry(), handle, baudRate, onLine);
  }
  async eraseRegion(
    handle: string,
    baudRate: number,
    address: number,
    size: number,
    onLine: EsptoolLineSink
  ) {
    await (await this.ops()).esptoolEraseRegion(
      this.registry(),
      handle,
      baudRate,
      address,
      size,
      onLine
    );
  }
  async run(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    await (await this.ops()).esptoolRun(this.registry(), handle, baudRate, onLine);
  }
}

class BridgedEsptoolBackend implements EsptoolBackend {
  constructor(private rpc: PanelRpcClient) {}

  private static INFO_TIMEOUT_MS = 120_000;

  private static ERASE_TIMEOUT_MS = 300_000;

  private static FLASH_TIMEOUT_MS = 600_000;

  private async withProgress<T>(
    handle: string,
    onLine: EsptoolLineSink,
    run: () => Promise<T>
  ): Promise<T> {
    const off = this.rpc.onEvent('esptool-progress', (payload) => {
      const p = payload as EsptoolProgressEventPayload;
      if (!p || p.handle !== handle) return;
      onLine(p.line);
    });
    try {
      return await run();
    } finally {
      off();
    }
  }

  async chipInfo(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    return this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-chip-info',
        { handle, baudRate },
        { timeoutMs: BridgedEsptoolBackend.INFO_TIMEOUT_MS }
      )
    );
  }
  async readMac(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    return this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-read-mac',
        { handle, baudRate },
        { timeoutMs: BridgedEsptoolBackend.INFO_TIMEOUT_MS }
      )
    );
  }
  async eraseFlash(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    await this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-erase-flash',
        { handle, baudRate },
        { timeoutMs: BridgedEsptoolBackend.ERASE_TIMEOUT_MS }
      )
    );
  }
  async flash(
    handle: string,
    baudRate: number,
    eraseAll: boolean,
    segments: EsptoolFlashSegment[],
    onLine: EsptoolLineSink
  ) {
    await this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-flash',
        {
          handle,
          baudRate,
          eraseAll,
          segments: segments.map((s) => ({ address: s.address, bytes: toArrayBuffer(s.data) })),
        },
        { timeoutMs: BridgedEsptoolBackend.FLASH_TIMEOUT_MS }
      )
    );
  }
  async readFlash(
    handle: string,
    baudRate: number,
    address: number,
    size: number,
    onLine: EsptoolLineSink
  ) {
    const { bytes } = await this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-read-flash',
        { handle, baudRate, address, size },
        { timeoutMs: BridgedEsptoolBackend.FLASH_TIMEOUT_MS }
      )
    );
    return new Uint8Array(bytes);
  }
  async readReg(handle: string, baudRate: number, address: number, onLine: EsptoolLineSink) {
    return this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-read-reg',
        { handle, baudRate, address },
        { timeoutMs: BridgedEsptoolBackend.INFO_TIMEOUT_MS }
      )
    );
  }
  async flashId(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    return this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-flash-id',
        { handle, baudRate },
        { timeoutMs: BridgedEsptoolBackend.INFO_TIMEOUT_MS }
      )
    );
  }
  async eraseRegion(
    handle: string,
    baudRate: number,
    address: number,
    size: number,
    onLine: EsptoolLineSink
  ) {
    await this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-erase-region',
        { handle, baudRate, address, size },
        { timeoutMs: BridgedEsptoolBackend.ERASE_TIMEOUT_MS }
      )
    );
  }
  async run(handle: string, baudRate: number, onLine: EsptoolLineSink) {
    await this.withProgress(handle, onLine, () =>
      this.rpc.call(
        'esptool-run',
        { handle, baudRate },
        { timeoutMs: BridgedEsptoolBackend.INFO_TIMEOUT_MS }
      )
    );
  }
}

export function resolveEsptoolBackend(
  hasLocalDom: boolean,
  panelRpc: PanelRpcClient | null
): EsptoolBackend | null {
  if (hasLocalDom && getNavigatorSerial()) {
    return new LocalEsptoolBackend();
  }
  if (panelRpc) {
    return new BridgedEsptoolBackend(panelRpc);
  }
  return null;
}
