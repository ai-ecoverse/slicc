/**
 * Wave 13c · R6 — `assertLocalModelPresent` probes
 * `/workspace/models/<modelId>/config.json` directly via the `preview-vfs`
 * BroadcastChannel responder (no preview SW round-trip). ENOENT surfaces the
 * canonical `hf download …` guidance; transport-level failures are wrapped
 * with the same line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installPreviewVfsResponder(files: Map<string, Uint8Array>): {
  dispose: () => void;
} {
  const channel = new BroadcastChannel('preview-vfs');
  const listener = (ev: MessageEvent): void => {
    const data = ev.data as { type: string; id: string; path: string; asText: boolean } | undefined;
    if (data?.type !== 'preview-vfs-read') return;
    const content = files.get(data.path);
    if (content === undefined) {
      channel.postMessage({
        type: 'preview-vfs-response',
        id: data.id,
        error: `ENOENT: ${data.path}`,
      });
      return;
    }
    channel.postMessage({ type: 'preview-vfs-response', id: data.id, content });
  };
  channel.addEventListener('message', listener);
  return {
    dispose: () => {
      channel.removeEventListener('message', listener);
      channel.close();
    },
  };
}

describe('assertLocalModelPresent — direct VFS probe (Wave 13c R6)', () => {
  let responder: ReturnType<typeof installPreviewVfsResponder> | null = null;

  beforeEach(async () => {
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
  });

  afterEach(async () => {
    responder?.dispose();
    responder = null;
    const mod = await import('../../src/speech/transformers-env.js');
    mod.__resetTransformersEnvForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves silently when the model config.json is present in the VFS', async () => {
    responder = installPreviewVfsResponder(
      new Map([
        [
          '/workspace/models/onnx-community/whisper-tiny/config.json',
          new TextEncoder().encode('{"model_type":"whisper"}'),
        ],
      ])
    );
    const { assertLocalModelPresent } = await import('../../src/speech/transformers-env.js');
    await expect(assertLocalModelPresent('onnx-community/whisper-tiny')).resolves.toBeUndefined();
  });

  it('throws the canonical `hf download …` guidance on ENOENT', async () => {
    responder = installPreviewVfsResponder(new Map());
    const { assertLocalModelPresent } = await import('../../src/speech/transformers-env.js');
    await expect(assertLocalModelPresent('onnx-community/whisper-tiny')).rejects.toThrow(
      /run `hf download onnx-community\/whisper-tiny`/
    );
  });

  it('wraps a transport-level failure with the same actionable guidance', async () => {
    // No responder installed AND BroadcastChannel stubbed away — the read
    // rejects synchronously with a transport-level error.
    vi.stubGlobal('BroadcastChannel', undefined);
    const { assertLocalModelPresent } = await import('../../src/speech/transformers-env.js');
    await expect(assertLocalModelPresent('onnx-community/Kokoro-82M-v1.0-ONNX')).rejects.toThrow(
      /hf download onnx-community\/Kokoro-82M-v1\.0-ONNX.*probe failed/
    );
  });
});
