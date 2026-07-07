/**
 * Tests for `createPanelTerminalHost` — the shared factory both the
 * standalone DedicatedWorker (`kernel-worker.ts`) and the extension
 * offscreen document (`chrome-extension/src/offscreen.ts`) call to
 * stand up the panel-driven `TerminalSessionHost`.
 *
 * The factory exists to pin parity: both floats MUST wire
 * `processManager` into both the host and the per-session
 * `AlmostBashShellHeadless`, so `ps` / `kill` / `/proc` work from the
 * panel terminal regardless of float.
 *
 * These tests use the real `AlmostBashShellHeadless` (over a fake
 * VirtualFS) so we exercise the shell + PM contract end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createPanelTerminalHost } from '../../src/kernel/panel-terminal-host.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { TerminalSessionClient } from '../../src/kernel/terminal-session-client.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { SudoManager } from '../../src/sudo/sudo-manager.js';
import type { SudoBroker, SudoDecision } from '../../src/sudo/types.js';
import { OffscreenClient } from '../../src/ui/offscreen-client.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeStubBrowser(): BrowserAPI {
  return {} as BrowserAPI;
}

interface Wired {
  pm: ProcessManager;
  client: TerminalSessionClient;
  panelClient: OffscreenClient;
  stop: () => void;
  channel: MessageChannel;
}

async function wirePanelHost(): Promise<Wired> {
  const fs = await VirtualFS.create({
    dbName: `pthost-test-${Math.random().toString(36).slice(2)}`,
    wipe: true,
  });
  const pm = new ProcessManager();
  const channel = new MessageChannel();
  const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
  const handle = createPanelTerminalHost({
    transport: bridgeTransport,
    fs,
    browser: makeStubBrowser(),
    processManager: pm,
    logger: { warn: vi.fn(), debug: vi.fn() },
  });

  const panelTransport = createPanelMessageChannelTransport(channel.port1);
  const panelClient = new OffscreenClient(
    {
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
    },
    panelTransport
  );
  const client = new TerminalSessionClient({ client: panelClient, sid: 's1' });

  return {
    pm,
    client,
    panelClient,
    stop: () => {
      client.close();
      handle.stop();
      channel.port1.close();
      channel.port2.close();
    },
    channel,
  };
}

describe('createPanelTerminalHost — imgcat media preview', () => {
  // imgcat checks for browser APIs before proceeding; stub them for Node.
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origDocument = (globalThis as Record<string, unknown>).document;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = {};
    (globalThis as Record<string, unknown>).document = {};
  });
  afterEach(() => {
    if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = origWindow;
    if (origDocument === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = origDocument;
  });

  it('emits terminal-media-preview when imgcat runs on an image file', async () => {
    const w = await wirePanelHost();
    await w.client.open();

    // Write a small PNG stub to the VFS so imgcat can read it.
    const fs = await VirtualFS.create({
      dbName: `pthost-imgcat-${Math.random().toString(36).slice(2)}`,
      wipe: true,
    });
    // We need a fresh host with this FS. Rebuild:
    w.stop();

    const pm = new ProcessManager();
    const channel = new MessageChannel();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs,
      browser: makeStubBrowser(),
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );

    const events: import('../../src/shell/terminal-protocol.js').TerminalEventMsg[] = [];
    const client = new TerminalSessionClient({
      client: panelClient,
      sid: 'img1',
      onEvent: (e) => events.push(e),
    });

    await client.open();

    // Write a minimal 1x1 PNG to VFS
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await fs.writeFile('/test.png', pngBytes);

    const result = await client.exec('imgcat /test.png');
    expect(result.exitCode).toBe(0);

    const mediaEvents = events.filter((e) => e.type === 'terminal-media-preview');
    expect(mediaEvents).toHaveLength(1);
    const mediaEvent =
      mediaEvents[0] as import('../../src/shell/terminal-protocol.js').TerminalMediaPreviewMsg;
    expect(mediaEvent.path).toBe('/test.png');
    expect(mediaEvent.mediaType).toBe('image/png');
    // data should be valid base64
    const decoded = atob(mediaEvent.data);
    expect(decoded.length).toBe(pngBytes.length);

    client.close();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('handles large files without stack overflow via chunked encoding', async () => {
    const fs = await VirtualFS.create({
      dbName: `pthost-large-${Math.random().toString(36).slice(2)}`,
      wipe: true,
    });
    const pm = new ProcessManager();
    const channel = new MessageChannel();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs,
      browser: makeStubBrowser(),
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );

    const events: import('../../src/shell/terminal-protocol.js').TerminalEventMsg[] = [];
    const client = new TerminalSessionClient({
      client: panelClient,
      sid: 'large1',
      onEvent: (e) => events.push(e),
    });

    await client.open();

    // Write a fake "large" JPEG (100KB of zeros with JPEG header)
    const size = 100 * 1024;
    const jpgBytes = new Uint8Array(size);
    jpgBytes[0] = 0xff;
    jpgBytes[1] = 0xd8;
    jpgBytes[2] = 0xff;
    await fs.writeFile('/big.jpg', jpgBytes);

    const result = await client.exec('imgcat /big.jpg');
    expect(result.exitCode).toBe(0);

    const mediaEvents = events.filter((e) => e.type === 'terminal-media-preview');
    expect(mediaEvents).toHaveLength(1);
    const mediaEvent =
      mediaEvents[0] as import('../../src/shell/terminal-protocol.js').TerminalMediaPreviewMsg;
    // Verify the full payload roundtrips correctly
    const decoded = atob(mediaEvent.data);
    expect(decoded.length).toBe(size);
    expect(decoded.charCodeAt(0)).toBe(0xff);
    expect(decoded.charCodeAt(1)).toBe(0xd8);

    client.close();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('emits multiple media-preview messages for imgcat with multiple files', async () => {
    const fs = await VirtualFS.create({
      dbName: `pthost-multi-${Math.random().toString(36).slice(2)}`,
      wipe: true,
    });
    const pm = new ProcessManager();
    const channel = new MessageChannel();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs,
      browser: makeStubBrowser(),
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );

    const events: import('../../src/shell/terminal-protocol.js').TerminalEventMsg[] = [];
    const client = new TerminalSessionClient({
      client: panelClient,
      sid: 'multi1',
      onEvent: (e) => events.push(e),
    });

    await client.open();

    // Write two small PNGs
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await fs.writeFile('/a.png', pngHeader);
    await fs.writeFile('/b.png', pngHeader);

    const result = await client.exec('imgcat /a.png /b.png');
    expect(result.exitCode).toBe(0);

    const mediaEvents = events.filter((e) => e.type === 'terminal-media-preview');
    expect(mediaEvents).toHaveLength(2);
    expect(
      (mediaEvents[0] as import('../../src/shell/terminal-protocol.js').TerminalMediaPreviewMsg)
        .path
    ).toBe('/a.png');
    expect(
      (mediaEvents[1] as import('../../src/shell/terminal-protocol.js').TerminalMediaPreviewMsg)
        .path
    ).toBe('/b.png');

    client.close();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });
});

describe('createPanelTerminalHost — parity wiring', () => {
  it('registers a kind:"shell" process for every panel-typed exec', async () => {
    const w = await wirePanelHost();
    await w.client.open();
    expect(w.pm.list()).toHaveLength(0);

    await w.client.exec('echo hi');
    const procs = w.pm.list();
    expect(procs.some((p) => p.kind === 'shell')).toBe(true);
    const shellProc = procs.find((p) => p.kind === 'shell')!;
    expect(shellProc.argv).toEqual(['echo hi']);
    expect(shellProc.status).toBe('exited');

    w.stop();
  });

  it('panel-typed exec is visible in pm.list() while running and is killable from another caller', async () => {
    const w = await wirePanelHost();
    await w.client.open();

    // `sleep 5` blocks for several seconds — long enough that we
    // can observe the process while it's running, deliver a signal,
    // and assert the abort.
    const execP = w.client.exec('sleep 5');
    await tick(20);
    const live = w.pm.list().find((p) => p.kind === 'shell' && p.status === 'running');
    expect(live).toBeDefined();

    // Another caller (simulating `kill <pid>` from a sibling shell)
    // delivers SIGINT through the manager.
    expect(w.pm.signal(live!.pid, 'SIGINT')).toBe(true);
    const result = await execP;
    // Exit-code semantics: cancelled commands return 130.
    expect(result.exitCode).toBe(130);
    expect(live!.terminatedBy).toBe('SIGINT');

    w.stop();
  });

  it('the same ProcessManager instance is shared between TerminalSessionHost and the shell', async () => {
    // This is the core parity guarantee: the manager passed to the
    // factory ends up in BOTH the session-host (so `terminal-exec`
    // registers `kind:"shell"`) AND the AlmostBashShellHeadless (so
    // tools/jsh inside the shell register their own kinds against
    // the same table). We exercise this by running a command and
    // then checking the process record's owner.
    const w = await wirePanelHost();
    await w.client.open();
    await w.client.exec('echo parity');
    const procs = w.pm.list();
    expect(procs.length).toBeGreaterThan(0);
    // Every panel-typed exec must be system-owned (the factory's
    // default processOwner) — proves the AlmostBashShellHeadless picked
    // up the same PM, not a different one.
    expect(procs[0].owner.kind).toBe('system');
    w.stop();
  });
});

describe('createPanelTerminalHost — sudo wiring (human terminal)', () => {
  // The panel terminal MUST register the explicit `sudo <cmd...>` command
  // when a SudoManager is threaded in, but MUST NOT prompt the human for
  // ordinary commands (transparentGating is pinned to false by the factory).

  async function wireWithSudoManager(): Promise<{
    pm: ProcessManager;
    client: TerminalSessionClient;
    broker: SudoBroker & { requestApproval: ReturnType<typeof vi.fn> };
    fs: VirtualFS;
    stop: () => void;
  }> {
    const fs = await VirtualFS.create({
      dbName: `pthost-sudo-${Math.random().toString(36).slice(2)}`,
      wipe: true,
    });
    const watcher = new FsWatcher();
    fs.setWatcher(watcher);
    // Seed an active policy that gates `touch /workspace/gated*` — proves
    // the transparent gate is OFF (otherwise the broker would be consulted
    // for the plain command below).
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile('/etc/sudoers', 'Cmnd  touch /workspace/gated*\n');
    const broker = {
      requestApproval: vi.fn(async (): Promise<SudoDecision> => ({ decision: 'allow' })),
    };
    const sudoManager = new SudoManager({ fs, watcher, broker });
    await sudoManager.init();

    const pm = new ProcessManager();
    const channel = new MessageChannel();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs,
      browser: {} as BrowserAPI,
      processManager: pm,
      sudoManager,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });

    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'sudo1' });

    return {
      pm,
      client,
      broker,
      fs,
      stop: () => {
        client.close();
        handle.stop();
        channel.port1.close();
        channel.port2.close();
        sudoManager.dispose();
      },
    };
  }

  it('plain commands run without prompting (transparent gate off in panel)', async () => {
    const w = await wireWithSudoManager();
    await w.client.open();

    // `touch /workspace/gated.txt` matches the active policy. The agent
    // shell would prompt for this; the panel shell must NOT.
    const result = await w.client.exec('touch /workspace/gated.txt');
    expect(result.exitCode).toBe(0);
    expect(await w.fs.exists('/workspace/gated.txt')).toBe(true);
    expect(w.broker.requestApproval).toHaveBeenCalledTimes(0);

    w.stop();
  });

  it('explicit `sudo <cmd>` prompts the human and runs on allow', async () => {
    const w = await wireWithSudoManager();
    await w.client.open();

    const result = await w.client.exec('sudo touch /workspace/gated.txt');
    expect(result.exitCode).toBe(0);
    expect(await w.fs.exists('/workspace/gated.txt')).toBe(true);
    expect(w.broker.requestApproval).toHaveBeenCalledTimes(1);
    const call = w.broker.requestApproval.mock.calls[0];
    expect((call[0] as { kind: string; detail: string }).kind).toBe('command');
    expect((call[0] as { kind: string; detail: string }).detail).toBe('touch /workspace/gated.txt');

    w.stop();
  });

  it('`sudo` without a SudoManager prints a clean "not configured" message', async () => {
    // No sudoManager arg → the explicit `sudo` command falls back to its
    // "not configured" message rather than crashing or hanging.
    const fs = await VirtualFS.create({
      dbName: `pthost-no-sudo-${Math.random().toString(36).slice(2)}`,
      wipe: true,
    });
    const pm = new ProcessManager();
    const channel = new MessageChannel();
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs,
      browser: {} as BrowserAPI,
      processManager: pm,
      logger: { warn: vi.fn(), debug: vi.fn() },
    });
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const panelClient = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const client = new TerminalSessionClient({ client: panelClient, sid: 'no-sudo' });
    await client.open();

    const result = await client.exec('sudo echo hi');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not configured');

    client.close();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
  });
});
