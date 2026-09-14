import { describe, expect, it } from 'vitest';
import { uploadHandler } from '../../../../../src/shell/supplemental-commands/playwright/handlers/upload.js';
import type { TabSnapshot } from '../../../../../src/shell/supplemental-commands/playwright/types.js';
import {
  allBytesFixture,
  countReplacementSeqs,
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
  vfsLikeReadFile,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

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

describe('uploadHandler binary fidelity (#2878)', () => {
  it('uploads the 0x00..0xFF fixture through the focused-input path without U+FFFD', async () => {
    const fixture = allBytesFixture();
    const files = new Map<string, string | Uint8Array>([['/allbytes.bin', fixture]]);
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
    const files = new Map<string, string | Uint8Array>([['/allbytes.bin', fixture]]);
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
    const files = new Map<string, string | Uint8Array>([['/note.txt', text]]);
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
