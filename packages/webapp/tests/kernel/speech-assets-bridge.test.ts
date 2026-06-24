import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  callEnsureSpeechAssets,
  installSpeechAssetsResponder,
  speechAssetsChannelName,
} from '../../src/kernel/speech-assets-bridge.js';
import type { SpeechAssetProgress } from '../../src/speech/ensure-speech-assets.js';

/** In-memory BroadcastChannel polyfill (mirrors panel-rpc.test). */
class FakeChannel {
  private static buses = new Map<string, Set<FakeChannel>>();
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;
  constructor(public readonly name: string) {
    let bus = FakeChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeChannel.buses.set(name, bus);
    }
    bus.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) return;
    const bus = FakeChannel.buses.get(this.name);
    if (!bus) return;
    for (const peer of bus) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const l of peer.listeners) l(new MessageEvent('message', { data }));
      });
    }
  }
  addEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.closed = true;
    FakeChannel.buses.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

let original: typeof BroadcastChannel | undefined;
beforeEach(() => {
  original = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
    FakeChannel as unknown as typeof BroadcastChannel;
});
afterEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
});

describe('speech-assets-bridge', () => {
  it('scopes the channel name by instanceId', () => {
    expect(speechAssetsChannelName()).toBe('slicc-speech-assets');
    expect(speechAssetsChannelName('abc')).toBe('slicc-speech-assets:abc');
  });

  it('round-trips a request, streaming progress and resolving on success', async () => {
    const progressSent: SpeechAssetProgress[] = [
      { asset: 'onnxruntime-web', phase: 'present' },
      { asset: 'owner/model', phase: 'done', filesLoaded: 2, filesTotal: 2 },
    ];
    const stop = installSpeechAssetsResponder({
      instanceId: 'i1',
      ensure: async (onProgress) => {
        for (const p of progressSent) onProgress(p);
        return { ok: true };
      },
    });
    const received: SpeechAssetProgress[] = [];
    await callEnsureSpeechAssets({
      instanceId: 'i1',
      onProgress: (p) => received.push(p),
    });
    expect(received).toEqual(progressSent);
    stop();
  });

  it('rejects with the worker-side error message', async () => {
    const stop = installSpeechAssetsResponder({
      instanceId: 'i2',
      ensure: async () => {
        throw new Error('huggingface.co unreachable');
      },
    });
    await expect(callEnsureSpeechAssets({ instanceId: 'i2' })).rejects.toThrow(
      /huggingface\.co unreachable/
    );
    stop();
  });

  it('rejects on idle timeout when no responder answers', async () => {
    await expect(
      callEnsureSpeechAssets({ instanceId: 'no-responder', idleTimeoutMs: 20 })
    ).rejects.toThrow(/no progress for 20ms/);
  });

  it('does not time out while progress keeps arriving', async () => {
    const stop = installSpeechAssetsResponder({
      instanceId: 'i3',
      ensure: async (onProgress) => {
        for (let i = 0; i < 4; i++) {
          onProgress({ asset: 'owner/model', phase: 'downloaded', filesLoaded: i + 1 });
          await new Promise((r) => setTimeout(r, 15));
        }
      },
    });
    // Idle timeout (25ms) exceeds each inter-progress gap (15ms) but is far
    // shorter than the total run (~60ms): only the resetting idle timer keeps
    // the call alive to completion.
    await expect(
      callEnsureSpeechAssets({ instanceId: 'i3', idleTimeoutMs: 25 })
    ).resolves.toBeUndefined();
    stop();
  });
});
