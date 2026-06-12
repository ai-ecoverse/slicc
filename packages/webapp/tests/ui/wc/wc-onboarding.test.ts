// @vitest-environment jsdom
/**
 * WC onboarding adapter: first-run detection posts the welcome dip as a
 * synthetic assistant message, returning users get nothing, and the welcome
 * lick interceptor consumes onboarding licks before they can reach the
 * (keyless) cone.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { LickEvent } from '../../../src/scoops/lick-manager.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import type { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';
import type { WcPageVfs } from '../../../src/ui/wc/wc-live.js';
import { wireWcOnboarding } from '../../../src/ui/wc/wc-onboarding.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** In-memory VFS standing in for the worker-owned remote clients. */
function makeVfs(files = new Map<string, string>()) {
  const writer = {
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return text;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, String(content));
    },
    readDir: async () => [],
    stat: async (path: string) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return { mtime: 0 };
    },
    mkdir: async () => undefined,
  };
  return { files, vfs: { reader: writer, writer } as unknown as WcPageVfs };
}

function makeClient() {
  return {
    sendSprinkleLick: vi.fn(),
    requestState: vi.fn(),
  } as unknown as OffscreenClient & { sendSprinkleLick: ReturnType<typeof vi.fn> };
}

function makeController() {
  return { addAssistantMessage: vi.fn() } as unknown as WcChatController & {
    addAssistantMessage: ReturnType<typeof vi.fn>;
  };
}

function inlineLick(action: string, data: unknown = {}): LickEvent {
  return {
    type: 'sprinkle',
    sprinkleName: 'inline',
    timestamp: new Date().toISOString(),
    body: { action, data },
  } as LickEvent;
}

describe('wireWcOnboarding', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('posts the welcome dip on a genuine first run', async () => {
    const { vfs } = makeVfs();
    const controller = makeController();
    await wireWcOnboarding({
      client: makeClient(),
      getController: () => controller,
      openVfs: async () => vfs,
      log,
    });
    await vi.waitFor(() => {
      const lines = controller.addAssistantMessage.mock.calls.map((c) => String(c[0]));
      expect(lines.join('\n')).toContain('welcome.shtml');
    });
  });

  it('stays silent for a returning user (.welcomed marker present)', async () => {
    const { vfs } = makeVfs(new Map([['/shared/.welcomed', '1']]));
    const controller = makeController();
    await wireWcOnboarding({
      client: makeClient(),
      getController: () => controller,
      openVfs: async () => vfs,
      log,
    });
    // Give the async detection chain a beat to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('stays silent when a tray-join URL is stored (follower instance)', async () => {
    localStorage.setItem('slicc.trayJoinUrl', 'https://tray.example.com/base/join/tray-join.abc');
    const { vfs } = makeVfs();
    const controller = makeController();
    await wireWcOnboarding({
      client: makeClient(),
      getController: () => controller,
      openVfs: async () => vfs,
      log,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('intercepts onboarding-complete: consumed, marker written, intro posted', async () => {
    const { files, vfs } = makeVfs();
    const client = makeClient();
    const controller = makeController();
    const handle = await wireWcOnboarding({
      client,
      getController: () => controller,
      openVfs: async () => vfs,
      log,
    });

    const consumed = handle.interceptWelcomeLick(
      inlineLick('onboarding-complete', { name: 'Lars' })
    );
    expect(consumed).toBe(true);
    // The lick never goes to the cone through this path.
    expect(client.sendSprinkleLick).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(files.get('/shared/.welcomed')).toBe('1');
      // Deterministic intro lines + the connect-llm dip reference.
      const lines = controller.addAssistantMessage.mock.calls.map((c) => String(c[0]));
      expect(lines.join('\n')).toContain('connect-llm.shtml');
    });
  });

  it('passes non-welcome licks through to the cone path', async () => {
    const { vfs } = makeVfs();
    const handle = await wireWcOnboarding({
      client: makeClient(),
      getController: () => makeController(),
      openVfs: async () => vfs,
      log,
    });
    expect(handle.interceptWelcomeLick(inlineLick('open-file', { path: '/x' }))).toBe(false);
    expect(
      handle.interceptWelcomeLick({
        type: 'webhook',
        timestamp: new Date().toISOString(),
        body: {},
      } as LickEvent)
    ).toBe(false);
  });
});
