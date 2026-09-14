import type { FloatbarFloatKind } from '@slicc/webcomponents';
import type { WorkUnitClient } from '../../work-unit/client/types.js';
import type { BootStageLogger } from '../boot/types.js';
import { attachWcChat, type WcChatAttachment } from './wc-chat.js';
import type { WcChatHost } from './wc-chat-host.js';
import { floatLabelForKind } from './wc-float-label.js';
import { installFloatbarStatus } from './wc-floatbar-online.js';
import { prepareWcShell, type WcShellBoot } from './wc-live.js';

export interface WcChatTransport {
  client: WorkUnitClient;

  host: WcChatHost;

  workbench?(boot: WcShellBoot, chat: WcChatAttachment): void | Promise<void>;
}

export interface WcShellMountOptions {
  floatKind: FloatbarFloatKind;

  floatLabel?: string;

  connect(boot: WcShellBoot): WcChatTransport | Promise<WcChatTransport>;
}

export interface MountedWcShell {
  boot: WcShellBoot;
  chat: WcChatAttachment;
}

export async function mountWcShell(
  app: HTMLElement,
  log: BootStageLogger,
  options: WcShellMountOptions
): Promise<MountedWcShell> {
  const floatLabel = options.floatLabel ?? floatLabelForKind(options.floatKind);
  const boot = prepareWcShell(app, floatLabel);
  installFloatbarStatus(boot.refs.floatbar, { floatKind: options.floatKind, label: floatLabel });

  const transport = await options.connect(boot);
  const chat = attachWcChat(boot, transport.client, transport.host);

  await transport.workbench?.(boot, chat);
  log.info('WC shell mounted', { floatKind: options.floatKind });
  return { boot, chat };
}
