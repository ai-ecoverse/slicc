import { vi } from 'vitest';
import type { BootStageLogger } from '../../../src/ui/boot/types.js';
import { attachWcChat } from '../../../src/ui/wc/wc-chat.js';
import type { WcChatHost } from '../../../src/ui/wc/wc-chat-host.js';
import { createLeaderChatHost } from '../../../src/ui/wc/wc-chat-host.js';
import type { AttachWcWorkbenchOptions, WcShellBoot } from '../../../src/ui/wc/wc-live.js';
import { attachWcWorkbench } from '../../../src/ui/wc/wc-live.js';
import { ensureWorkUnitClient } from '../../../src/ui/wc/wc-live-callbacks.js';

export function leaderChatHostFakes(): Record<string, unknown> {
  return {
    createAgentHandle: () => ({ onEvent: () => () => undefined }),
    emitAgentError: vi.fn(),
    sendSprinkleLick: vi.fn(),
    sendToolUiAction: vi.fn(),
  };
}

export function installLeaderChatHost(boot: WcShellBoot, client: unknown): WcChatHost {
  const host = createLeaderChatHost(client as never);
  boot.setChatTransport(ensureWorkUnitClient(boot.wiring), host);
  return host;
}

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
