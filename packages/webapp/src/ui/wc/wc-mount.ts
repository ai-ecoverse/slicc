/**
 * The ONE mount path for the WC shell (#2382 PR D2b).
 *
 * Every float — standalone, Electron overlay, hosted leader, extension side
 * panel and popout, browser follower, Cherry embed — builds the same frame,
 * wires the same chat surface onto it, and differs only in the TRANSPORT it
 * hands over and whether it has a kernel to open a workbench on.
 *
 * There used to be three mounts (`mountWcUiLive`, `mountWcUiExtension`,
 * `mountWcUiFollower`), each with its own controller, strip publisher,
 * selection and composer wiring. What is left of them are three CONNECTORS
 * (`bootLeaderFloat`, `bootExtensionFloat`, `bootFollowerFloat`): a prelude,
 * a transport, and a call to this function. They drifted: three switcher orderings
 * existed at once before #2317, a follower's Stop button had no listener at
 * all until PR A, and its model pill latched an empty catalog for a whole
 * session (#2329). One path is what stops that class of bug from being
 * possible rather than merely fixed.
 */

import type { FloatbarFloatKind } from '@slicc/webcomponents';
import type { WorkUnitClient } from '../../work-unit/client/types.js';
import type { BootStageLogger } from '../boot/types.js';
import { attachWcChat, type WcChatAttachment } from './wc-chat.js';
import type { WcChatHost } from './wc-chat-host.js';
import { floatLabelForKind } from './wc-float-label.js';
import { installFloatbarStatus } from './wc-floatbar-online.js';
import { prepareWcShell, type WcShellBoot } from './wc-live.js';

/** What a float hands the shell once the frame exists. */
export interface WcChatTransport {
  /** The protocol the shell renders from. */
  client: WorkUnitClient;
  /** What the protocol cannot do on this float. */
  host: WcChatHost;
  /**
   * Leader-only second half: VFS, terminal, monitor, sprinkles, permissions,
   * transcript export, sudo and stats — everything that needs a kernel. A
   * follower has none and simply omits it.
   */
  workbench?(boot: WcShellBoot, chat: WcChatAttachment): void | Promise<void>;
}

export interface WcShellMountOptions {
  /** Names the serving runtime in the floatbar (npx / sliccstart / hosted / …). */
  floatKind: FloatbarFloatKind;
  /** Overrides the label derived from {@link WcShellMountOptions.floatKind}. */
  floatLabel?: string;
  /**
   * Build the transport, given the shell that will render it.
   *
   * A callback rather than a value because the ordering is real: a leader's
   * `OffscreenClient` is constructed FROM this shell's callback bag
   * (`createWcLiveCallbacks(boot.wiring)`), so the frame has to exist before
   * the client does. A follower's client could be passed in directly; making
   * both go through the same door is what keeps this one mount path honest.
   */
  connect(boot: WcShellBoot): WcChatTransport | Promise<WcChatTransport>;
}

/** What the float keeps wiring after the shell is up. */
export interface MountedWcShell {
  boot: WcShellBoot;
  chat: WcChatAttachment;
}

/**
 * Build the shell frame, wire the chat surface onto it, and open the
 * workbench when the float has a kernel behind it.
 */
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
  // Awaited: a float that opens a workbench is not "mounted" until its
  // panels can be activated — the dock-tree restore fires them immediately.
  await transport.workbench?.(boot, chat);
  log.info('WC shell mounted', { floatKind: options.floatKind });
  return { boot, chat };
}
