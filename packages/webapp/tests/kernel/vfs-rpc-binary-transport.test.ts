/**
 * Regression test for review comment 3362777636 on PR #876:
 * binary `Uint8Array` payloads must survive the chrome.runtime
 * transport in BOTH directions (panel→offscreen write and
 * offscreen→panel read).
 *
 * `chrome.runtime.sendMessage` is JSON-serialising in practice between
 * extension contexts, so raw `Uint8Array` values arrive at the
 * receiver as plain `{ [i]: byte }` objects and fail the host's
 * `instanceof Uint8Array` guard. This test wires `WritableVfsClient`
 * to `VfsRpcHost` over a transport that simulates that JSON boundary
 * — `JSON.parse(JSON.stringify(payload))` on each send — and asserts:
 *
 *   - binary writeFile bytes arrive at the backend as a real
 *     `Uint8Array` (the host's binary guard succeeds);
 *   - binary readFile bytes arrive at the panel as a real
 *     `Uint8Array` with the correct contents (the panel's
 *     instance-check would otherwise drop the data to `[object Object]`).
 *
 * The codec wrapper lives in `transport-chrome-runtime.ts`; this test
 * uses {@link encodeBinaryForTransport} / {@link decodeBinaryForTransport}
 * directly so we don't need a real `chrome.runtime` global.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from '../../../chrome-extension/src/messages.js';
import type { Stats } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import {
  decodeBinaryForTransport,
  encodeBinaryForTransport,
} from '../../src/kernel/transport-binary-codec.js';
import type { KernelTransport } from '../../src/kernel/types.js';
import { startVfsRpcHost } from '../../src/kernel/vfs-rpc-host.js';
import {
  createRemoteWritableVfsClient,
  type WritableVfsBackend,
} from '../../src/kernel/writable-vfs-client.js';

/**
 * Build a paired client/host transport that simulates a JSON-serialising
 * `chrome.runtime`-style wire: every send is encoded, JSON-stringified,
 * parsed back, and decoded before delivery. Mirrors the production
 * `transport-chrome-runtime.ts` wrapping.
 */
function createJsonPair(): {
  panel: KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
  host: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
} {
  const panelHandlers = new Set<(msg: ExtensionMessage) => void>();
  const hostHandlers = new Set<(msg: ExtensionMessage) => void>();
  const wire =
    (source: 'panel' | 'offscreen') =>
    (payload: unknown): void => {
      const encoded = encodeBinaryForTransport(payload);
      const json = JSON.parse(JSON.stringify({ source, payload: encoded }));
      const decoded = decodeBinaryForTransport(json) as ExtensionMessage;
      const targets = source === 'panel' ? hostHandlers : panelHandlers;
      queueMicrotask(() => {
        for (const h of targets) h(decoded);
      });
    };
  return {
    panel: {
      onMessage: (h) => {
        panelHandlers.add(h as (msg: ExtensionMessage) => void);
        return () => panelHandlers.delete(h as (msg: ExtensionMessage) => void);
      },
      send: wire('panel'),
    },
    host: {
      onMessage: (h) => {
        hostHandlers.add(h as (msg: ExtensionMessage) => void);
        return () => hostHandlers.delete(h as (msg: ExtensionMessage) => void);
      },
      send: wire('offscreen'),
    },
  };
}

function makeReadClient(payload: string | Uint8Array): LocalVfsClient {
  return {
    readDir: vi.fn(async () => []),
    readFile: vi.fn(async () => payload),
    stat: vi.fn(async () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }) as unknown as Stats),
  };
}

function makeWritableBackend(): {
  backend: WritableVfsBackend;
  writeFile: ReturnType<typeof vi.fn>;
} {
  const writeFile = vi.fn(async (_p: string, _d: unknown) => {});
  return {
    backend: {
      writeFile,
      mkdir: async () => {},
      rm: async () => {},
      flush: async () => {},
    },
    writeFile,
  };
}

describe('VFS RPC over JSON-serialising transport', () => {
  it('binary writeFile delivers a real Uint8Array to the host', async () => {
    const { panel, host } = createJsonPair();
    const { backend, writeFile } = makeWritableBackend();
    const stop = startVfsRpcHost({
      transport: host,
      client: makeReadClient(''),
      writableClient: backend,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const client = createRemoteWritableVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f, 0xff]);
    await client.writeFile('/image.png', bytes);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, data] = writeFile.mock.calls[0];
    expect(path).toBe('/image.png');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f, 0xff]);
    client.dispose();
    stop.stop();
  });

  it('binary readFile returns a real Uint8Array to the panel', async () => {
    const { panel, host } = createJsonPair();
    const sourceBytes = new Uint8Array([1, 2, 3, 4, 5, 0xff]);
    const stop = startVfsRpcHost({
      transport: host,
      client: makeReadClient(sourceBytes),
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const client = createRemoteWritableVfsClient({
      transport: panel,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const result = await client.readFile('/image.png', { encoding: 'binary' });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3, 4, 5, 0xff]);
    client.dispose();
    stop.stop();
  });
});
