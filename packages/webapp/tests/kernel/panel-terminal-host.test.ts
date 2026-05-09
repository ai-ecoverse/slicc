/**
 * Tests for `createPanelTerminalHost` — the shared factory both the
 * standalone DedicatedWorker (`kernel-worker.ts`) and the extension
 * offscreen document (`chrome-extension/src/offscreen.ts`) call to
 * stand up the panel-driven `TerminalSessionHost`.
 *
 * The factory exists to pin parity: both floats MUST wire
 * `processManager` into both the host and the per-session
 * `WasmShellHeadless`, so `ps` / `kill` / `/proc` work from the
 * panel terminal regardless of float.
 *
 * These tests use the real `WasmShellHeadless` (over a fake
 * VirtualFS) so we exercise the shell + PM contract end-to-end.
 */

import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createPanelTerminalHost } from '../../src/kernel/panel-terminal-host.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { TerminalSessionClient } from '../../src/kernel/terminal-session-client.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { OffscreenClient } from '../../src/ui/offscreen-client.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { BrowserAPI } from '../../src/cdp/index.js';

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
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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
    // registers `kind:"shell"`) AND the WasmShellHeadless (so
    // tools/jsh inside the shell register their own kinds against
    // the same table). We exercise this by running a command and
    // then checking the process record's owner.
    const w = await wirePanelHost();
    await w.client.open();
    await w.client.exec('echo parity');
    const procs = w.pm.list();
    expect(procs.length).toBeGreaterThan(0);
    // Every panel-typed exec must be system-owned (the factory's
    // default processOwner) — proves the WasmShellHeadless picked
    // up the same PM, not a different one.
    expect(procs[0].owner.kind).toBe('system');
    w.stop();
  });
});
