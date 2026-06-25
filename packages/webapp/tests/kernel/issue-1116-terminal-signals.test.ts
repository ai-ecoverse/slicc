/**
 * Reproduction for issue #1116 — "kill -9 and Ctrl-C no longer terminate
 * processes in the terminal (all surfaces)".
 *
 * Drives the REAL panel terminal signal path end-to-end:
 *   TerminalSessionClient → TerminalSessionHost → AlmostBashShellHeadless
 *   → node-command → runInRealm → ProcessManager.
 *
 * Root cause these tests pin: a panel-typed command spawns an OUTER
 * `kind:'shell'` process, and realm-backed commands (`node`/`.jsh`/python)
 * spawn an INNER `kind:'jsh'` realm process that does the actual work.
 * The terminal signal path (`handleSignal`) and `kill -9 <pid>` only reach
 * the outer shell process; the inner realm child is never signalled, so the
 * foreground job runs forever and the prompt never returns.
 *
 * The control case proves the realm runner DOES terminate (exit 137) when
 * the signal actually reaches the realm pid — isolating the defect to the
 * terminal→realm signal routing. Ctrl-C and kill -9 therefore share ONE
 * root cause.
 *
 * EXPECTED ON UNMODIFIED SOURCE: the two repro cases FAIL (the exec hangs
 * past the budget) while the control passes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { BrowserAPI } from '../../src/cdp/index.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createPanelTerminalHost } from '../../src/kernel/panel-terminal-host.js';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { TerminalSessionClient } from '../../src/kernel/terminal-session-client.js';
import {
  createBridgeMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { OffscreenClient } from '../../src/ui/offscreen-client.js';

/** A realm-backed foreground job that yields (so the in-process realm can settle). */
const YIELDING_NODE = "node -e 'await new Promise(r=>setTimeout(r,60000))'";
/** How long we wait for a terminated job to return to the prompt. */
const BUDGET_MS = 1500;

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makePanelClient(transport: ReturnType<typeof createPanelMessageChannelTransport>) {
  return new OffscreenClient(
    {
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
    },
    transport
  );
}

async function wire() {
  const fs = await VirtualFS.create({
    dbName: `issue-1116-${Math.random().toString(36).slice(2)}`,
    wipe: true,
  });
  const pm = new ProcessManager();
  // The kernel host publishes the shared PM on globalThis so `node -e`
  // (which doesn't receive a pmConfig) registers its realm in the same table
  // that `ps` / `kill` see. Mirror that production wiring here.
  (globalThis as Record<string, unknown>).__slicc_pm = pm;
  const channel = new MessageChannel();
  const handle = createPanelTerminalHost({
    transport: createBridgeMessageChannelTransport(channel.port2),
    fs,
    browser: {} as BrowserAPI,
    processManager: pm,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  });
  const client = new TerminalSessionClient({
    client: makePanelClient(createPanelMessageChannelTransport(channel.port1)),
    sid: 's1',
  });
  const teardown = () => {
    client.close();
    handle.stop();
    channel.port1.close();
    channel.port2.close();
    delete (globalThis as Record<string, unknown>).__slicc_pm;
  };
  return { fs, pm, client, channel, teardown };
}

/** Resolve once the realm (`kind:'jsh'`) child of the foreground job exists. */
async function waitForRealmPid(pm: ProcessManager): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const realm = pm.list().find((p) => p.kind === 'jsh' && p.status === 'running');
    if (realm) return realm.pid;
    await tick(10);
  }
  throw new Error('realm process never registered');
}

async function raceExec(execPromise: Promise<{ exitCode: number }>) {
  return Promise.race([
    execPromise.then((r) => ({ timedOut: false as const, exitCode: r.exitCode })),
    tick(BUDGET_MS).then(() => ({ timedOut: true as const, exitCode: -1 })),
  ]);
}

describe('issue #1116 — terminal signals do not terminate realm-backed jobs', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_pm;
  });

  it('Ctrl-C (SIGINT) interrupts a busy realm-backed foreground job', async () => {
    const w = await wire();
    await w.client.open();
    const execPromise = w.client.exec(YIELDING_NODE);
    const realmPid = await waitForRealmPid(w.pm);
    w.client.signal('SIGINT'); // Ctrl-C
    const outcome = await raceExec(execPromise);
    const realmStatus = w.pm.get(realmPid)?.status;
    w.teardown();
    expect(
      outcome.timedOut,
      '#1116: Ctrl-C (SIGINT) did not interrupt the foreground job — the exec ' +
        'never returned to the prompt (signal reached the shell process but not its realm child)'
    ).toBe(false);
    expect(realmStatus, '#1116: realm process still running after SIGINT').not.toBe('running');
  }, 10_000);

  it('kill -9 <pid> force-terminates a busy realm-backed foreground job', async () => {
    const w = await wire();
    await w.client.open();
    // Second terminal session so we can type `kill -9` while session 1 blocks.
    const client2 = new TerminalSessionClient({
      client: makePanelClient(createPanelMessageChannelTransport(w.channel.port1)),
      sid: 's2',
    });
    await client2.open();
    const execPromise = w.client.exec(YIELDING_NODE);
    await waitForRealmPid(w.pm);
    // The top-level `node -e ...` process the user sees in `ps`.
    const shellPid = w.pm.list().find((p) => p.kind === 'shell' && p.status === 'running')?.pid;
    await client2.exec(`kill -9 ${shellPid}`);
    const outcome = await raceExec(execPromise);
    client2.close();
    w.teardown();
    expect(
      outcome.timedOut,
      `#1116: kill -9 ${shellPid} did not terminate the foreground job — ` +
        'the exec never returned to the prompt'
    ).toBe(false);
  }, 10_000);

  it('control: signalling the realm pid directly DOES terminate (exit 137)', async () => {
    const w = await wire();
    await w.client.open();
    const execPromise = w.client.exec(YIELDING_NODE);
    const realmPid = await waitForRealmPid(w.pm);
    w.pm.signal(realmPid, 'SIGKILL');
    const outcome = await raceExec(execPromise);
    w.teardown();
    expect(outcome.timedOut, 'control: realm-targeted SIGKILL should settle the job').toBe(false);
    expect(outcome.exitCode, 'control: SIGKILL exit code').toBe(137);
  }, 10_000);
});
