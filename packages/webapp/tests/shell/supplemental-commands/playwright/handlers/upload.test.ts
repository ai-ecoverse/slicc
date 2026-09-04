import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  readUploadBytes,
  uploadHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/upload.js';
import type { TabSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

/** Issue #2878 fixture: every byte 0x00..0xFF exactly once. */
function allBytesFixture(): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, i) => i);
}

function countReplacementSeqs(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) {
      n++;
      i += 2;
    }
  }
  return n;
}

function decodeUploadedBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function makeSnapshot(over: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    url: 'https://x',
    title: 't',
    content: '',
    timestamp: 0,
    refToSelector: new Map(),
    refToBackendNodeId: new Map(),
    refToFrameId: new Map(),
    ...over,
  };
}

type StoredFile = string | Uint8Array;

/**
 * VirtualFS-shaped reader: default encoding is UTF-8 with replacement, matching
 * production `VirtualFS.readFile`. `{ encoding: 'binary' }` returns the stored
 * bytes. A test that forgets `encoding: 'binary'` sees U+FFFD for high bytes.
 */
function vfsLikeReadFile(files: Map<string, StoredFile>): VirtualFS['readFile'] {
  return (async (path: string, options?: { encoding?: string }) => {
    const stored = files.get(path);
    if (stored === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' as const });
    }
    const encoding = options?.encoding ?? 'utf-8';
    if (stored instanceof Uint8Array) {
      if (encoding === 'binary') return stored;
      return new TextDecoder('utf-8').decode(stored);
    }
    if (encoding === 'binary') return new TextEncoder().encode(stored);
    return stored;
  }) as VirtualFS['readFile'];
}

type TransportCall = { method: string; params: Record<string, unknown> };

function captureTransport(): {
  transport: ReturnType<typeof createMockTransport>;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport = createMockTransport((method, params) => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-file-input' } };
    if (method === 'Runtime.callFunctionOn' || method === 'Runtime.evaluate') {
      return { result: { value: 1 } };
    }
    return {};
  });
  return { transport, calls };
}

function filesFromTransport(calls: TransportCall[]): Array<{
  name: string;
  type: string;
  base64: string;
}> {
  const callFn = calls.find((c) => c.method === 'Runtime.callFunctionOn');
  if (callFn) {
    const args = callFn.params['arguments'] as Array<{ value: unknown }> | undefined;
    return (args?.[0]?.value ?? []) as Array<{ name: string; type: string; base64: string }>;
  }
  const evalCall = calls.find((c) => c.method === 'Runtime.evaluate');
  const expression = evalCall?.params['expression'] as string | undefined;
  if (!expression) return [];
  const match = expression.match(/var filesData = (\[[\s\S]*?\]);/);
  if (!match) return [];
  return JSON.parse(match[1]) as Array<{ name: string; type: string; base64: string }>;
}

describe('readUploadBytes', () => {
  it('returns stored bytes when encoding:binary is honoured', async () => {
    const fixture = allBytesFixture();
    const files = new Map<string, StoredFile>([['/allbytes.bin', fixture]]);
    const bytes = await readUploadBytes(
      { readFile: vfsLikeReadFile(files) } as VirtualFS,
      '/allbytes.bin'
    );
    expect(bytes.length).toBe(256);
    expect(Array.from(bytes)).toEqual(Array.from(fixture));
    expect(countReplacementSeqs(bytes)).toBe(0);
  });

  it('fails loudly when a text decode already substituted U+FFFD', async () => {
    const readFile = vi.fn(async () => 'ASCII\uFFFDMORE');
    await expect(
      readUploadBytes({ readFile } as unknown as VirtualFS, '/corrupt.bin')
    ).rejects.toThrow(/faithfully/);
    expect(readFile).toHaveBeenCalledWith('/corrupt.bin', { encoding: 'binary' });
  });

  it('encodes a valid UTF-8 string without substitution', async () => {
    const readFile = vi.fn(async () => 'café');
    const bytes = await readUploadBytes({ readFile } as unknown as VirtualFS, '/note.txt');
    expect(new TextDecoder().decode(bytes)).toBe('café');
    expect(countReplacementSeqs(bytes)).toBe(0);
  });
});

describe('uploadHandler binary fidelity (#2878)', () => {
  it('uploads the 0x00..0xFF fixture through the focused-input path without U+FFFD', async () => {
    const fixture = allBytesFixture();
    const files = new Map<string, StoredFile>([['/allbytes.bin', fixture]]);
    const { transport, calls } = captureTransport();
    const { browser } = createMockBrowser({ transport });

    const result = await uploadHandler(
      createHandlerCtx({
        browser,
        fs: { readFile: vfsLikeReadFile(files) },
        positional: ['/allbytes.bin'],
        flags: { tab: TAB },
      })
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('allbytes.bin');
    expect(calls.some((c) => c.method === 'Runtime.evaluate')).toBe(true);
    expect(calls.some((c) => c.method === 'DOM.resolveNode')).toBe(false);

    const uploaded = filesFromTransport(calls);
    expect(uploaded).toHaveLength(1);
    const decoded = decodeUploadedBase64(uploaded[0].base64);
    expect(decoded.length).toBe(256);
    expect(countReplacementSeqs(decoded)).toBe(0);
    expect(Array.from(decoded)).toEqual(Array.from(fixture));
  });

  it('uploads the 0x00..0xFF fixture through a snapshot ref without U+FFFD', async () => {
    const fixture = allBytesFixture();
    const files = new Map<string, StoredFile>([['/allbytes.bin', fixture]]);
    const { transport, calls } = captureTransport();
    const { browser } = createMockBrowser({ transport });
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e2', 99]]) }));

    const result = await uploadHandler(
      createHandlerCtx({
        browser,
        state,
        fs: { readFile: vfsLikeReadFile(files) },
        positional: ['e2', '/allbytes.bin'],
        flags: { tab: TAB },
      })
    );

    expect(result.exitCode).toBe(0);
    const resolveCall = calls.find((c) => c.method === 'DOM.resolveNode');
    expect(resolveCall?.params['backendNodeId']).toBe(99);
    expect(calls.some((c) => c.method === 'Runtime.evaluate')).toBe(false);

    const uploaded = filesFromTransport(calls);
    const decoded = decodeUploadedBase64(uploaded[0].base64);
    expect(decoded.length).toBe(256);
    expect(countReplacementSeqs(decoded)).toBe(0);
    expect(Array.from(decoded)).toEqual(Array.from(fixture));
  });

  it('still uploads valid UTF-8 text files byte-exactly', async () => {
    const text = 'hello café — ASCII plus valid UTF-8';
    const files = new Map<string, StoredFile>([['/note.txt', text]]);
    const { transport, calls } = captureTransport();
    const { browser } = createMockBrowser({ transport });

    const result = await uploadHandler(
      createHandlerCtx({
        browser,
        fs: { readFile: vfsLikeReadFile(files) },
        positional: ['/note.txt'],
        flags: { tab: TAB },
      })
    );

    expect(result.exitCode).toBe(0);
    const uploaded = filesFromTransport(calls);
    const decoded = decodeUploadedBase64(uploaded[0].base64);
    expect(new TextDecoder().decode(decoded)).toBe(text);
    expect(uploaded[0].type).toBe('text/plain');
  });
});

describe('uploadHandler ref argv', () => {
  it('treats a leading eN token as a ref even without a snapshot (does not ENOENT /e2)', async () => {
    const result = await uploadHandler(
      createHandlerCtx({
        positional: ['e2', '/allbytes.bin'],
        flags: { tab: TAB },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No snapshot available');
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('rejects an unknown snapshot ref instead of opening it as a path', async () => {
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e1', 1]]) }));
    const result = await uploadHandler(
      createHandlerCtx({
        state,
        positional: ['e2', '/allbytes.bin'],
        flags: { tab: TAB },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown ref "e2"');
    expect(result.stderr).not.toContain('ENOENT');
  });

  it('still requires a file path after consuming the ref', async () => {
    const state = createPlaywrightState();
    state.snapshots.set(TAB, makeSnapshot({ refToBackendNodeId: new Map([['e3', 44]]) }));
    const result = await uploadHandler(
      createHandlerCtx({
        state,
        positional: ['e3'],
        flags: { tab: TAB },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('upload requires at least one file path');
  });
});
