import { describe, expect, it } from 'vitest';
import { mountSliccImpl } from '../src/mount.js';
import type { CherryEnvelope } from '../src/protocol.js';

describe('cherry features', () => {
  it('includes resolved features in handshake.welcome', async () => {
    const container = document.createElement('div');
    const posted: CherryEnvelope[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      features: { terminal: false },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env),
    });

    // Simulate the iframe sending handshake.hello
    await handle.__test_receive({
      cherry: 1,
      channelId: 'cherry-test-123',
      kind: 'handshake.hello',
      capabilities: { navigate: true, screenshot: true, openUrl: true },
    });

    const welcome = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcome).toBeTruthy();
    expect((welcome as any).features).toEqual({
      terminal: false,
      files: true,
      memory: true,
      browser: true,
      modelPicker: true,
      history: true,
      nav: true,
      newSprinkle: true,
      monitor: true,
      showTimestamps: true,
    });
    handle.destroy();
  });

  it('defaults all features to true when features option is omitted', async () => {
    const container = document.createElement('div');
    const posted: CherryEnvelope[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env),
    });

    await handle.__test_receive({
      cherry: 1,
      channelId: 'cherry-test-456',
      kind: 'handshake.hello',
      capabilities: { navigate: true, screenshot: true, openUrl: true },
    });

    const welcome = posted.find((e) => e.kind === 'handshake.welcome');
    expect((welcome as any).features).toEqual({
      terminal: true,
      files: true,
      memory: true,
      browser: true,
      modelPicker: true,
      history: true,
      nav: true,
      newSprinkle: true,
      monitor: true,
      showTimestamps: true,
    });
    handle.destroy();
  });
});
