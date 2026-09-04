/**
 * The leader's chat seam over a fake `OffscreenClient` (#2382 D2b).
 *
 * `prepareWcShell` renders a selection through `WcChatHost`, not through the
 * client, so a test that drives `selectScoop` and then asserts on a client
 * call has to install the same host production does. Building it here — from
 * `createLeaderChatHost`, not by hand — means a test cannot accidentally
 * assert against a seam the shell does not actually use.
 */

import { vi } from 'vitest';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import { attachWcChat } from '../../../src/ui/wc/wc-chat.js';
import type { WcChatHost } from '../../../src/ui/wc/wc-chat-host.js';
import { createLeaderChatHost } from '../../../src/ui/wc/wc-chat-host.js';
import type { AttachWcWorkbenchOptions, WcShellBoot } from '../../../src/ui/wc/wc-live.js';
import { attachWcWorkbench } from '../../../src/ui/wc/wc-live.js';
import { ensureWorkUnitClient } from '../../../src/ui/wc/wc-live-callbacks.js';

/** The members `createLeaderChatHost` reads, with test doubles for each. */
export function leaderChatHostFakes(): Record<string, unknown> {
  return {
    createAgentHandle: () => ({ onEvent: () => () => undefined }),
    emitAgentError: vi.fn(),
    sendSprinkleLick: vi.fn(),
    sendToolUiAction: vi.fn(),
  };
}

/**
 * Install the leader host over `client` and hand it back, so a test can drive
 * `boot.selectScoop` exactly as the leader mount does.
 */
export function installLeaderChatHost(boot: WcShellBoot, client: unknown): WcChatHost {
  const host = createLeaderChatHost(client as never);
  boot.setChatTransport(ensureWorkUnitClient(boot.wiring), host);
  return host;
}

/**
 * Attach a leader shell over a fake client, in the order the leader mount
 * uses (#2382 D2b): the chat surface first, then the workbench that needs a
 * kernel. This is `mountWcShell`'s `connect` without the kernel spawn.
 */
export function attachLeaderShell(
  boot: WcShellBoot,
  client: unknown,
  log: BootStageLogger,
  options?: AttachWcWorkbenchOptions
): (() => void) | undefined {
  const host = createLeaderChatHost(client as never);
  const chat = attachWcChat(boot, ensureWorkUnitClient(boot.wiring), host);
  return attachWcWorkbench(boot, client as never, chat, host, log, options);
}
