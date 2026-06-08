/**
 * `setup-standalone-kernel.ts` — kernel-host spawn + migration splash +
 * scoop selection (selectScoop + syncThinkingButton). Extracted from
 * `mainStandaloneWorker` so the orchestrator stays close to the
 * per-function cap. The host's callbacks all close over a mutable
 * `selectedScoop` ref the caller owns.
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { CDPTransport } from '../../cdp/index.js';
import { spawnKernelWorker } from '../../kernel/spawn.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { Layout } from '../layout.js';
import { isLickChannel } from '../lick-channels.js';
import { createMigrationSplash } from '../migration-splash.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { resolveCurrentModel, resolveModelById } from '../provider-settings.js';
import type { ChatMessage } from '../types.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneKernelSetupDeps {
  realCdpTransport: CDPTransport;
  instanceId: string;
  layout: Layout;
  log: BootStageLogger;
  getSelectedScoop(): RegisteredScoop | null;
  setSelectedScoop(scoop: RegisteredScoop | null): void;
}

export interface StandaloneKernelHandle {
  client: OffscreenClient;
  hostReady: Promise<void>;
  hostDispose(): void;
  selectScoop(scoop: RegisteredScoop): Promise<void>;
  syncThinkingButtonForScoop(scoop: RegisteredScoop): void;
  /** Releases the migration splash; safe on the boot-failure path. */
  disarmMigrationSplash(): void;
}

export function setupStandaloneKernel(deps: StandaloneKernelSetupDeps): StandaloneKernelHandle {
  const { realCdpTransport, instanceId, layout, log, getSelectedScoop, setSelectedScoop } = deps;

  const syncThinkingButtonForScoop = (scoop: RegisteredScoop): void => {
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    layout.panels.chat.setModelSupportsReasoning(
      !!model.reasoning,
      getSupportedThinkingLevels(model).includes('xhigh')
    );
    layout.panels.chat.setThinkingLevel(scoop.config?.thinkingLevel);
  };

  let client!: OffscreenClient;
  const selectScoop = async (scoop: RegisteredScoop): Promise<void> => {
    setSelectedScoop(scoop);
    client.setSelectedScoopJid(scoop.jid);
    layout.panels.scoops.setSelectedJid(scoop.jid);
    layout.panels.memory.setSelectedScoop(scoop.jid);
    layout.setScoopSwitcherSelected?.(scoop.jid);
    const contextId = scoop.isCone ? 'session-cone' : `session-${scoop.folder}`;
    const scoopName = scoop.isCone ? undefined : scoop.name;
    await layout.panels.chat.switchToContext(contextId, !scoop.isCone, scoopName);
    client.requestScoopMessages(scoop.jid);
    if (client.isProcessing(scoop.jid)) layout.panels.chat.setProcessing(true);
    syncThinkingButtonForScoop(scoop);
  };

  let migrationSplash: ReturnType<typeof createMigrationSplash> | null = null;
  const disarmMigrationSplash = (): void => {
    migrationSplash?.disarm();
  };
  const ensureSplash = (arm = true): void => {
    if (!migrationSplash) {
      migrationSplash = createMigrationSplash({ root: document.body, logger: log });
      if (arm) migrationSplash.arm();
    }
  };

  const host = spawnKernelWorker({
    realCdpTransport,
    instanceId,
    onMigrationStart: () => ensureSplash(true),
    onMigrationProgress: (progress) => {
      ensureSplash(true);
      migrationSplash?.updateProgress(progress);
    },
    onMigrationFinish: () => {
      disarmMigrationSplash();
    },
    callbacks: {
      onStatusChange: (jid, status) => handleStatus(jid, status, layout, getSelectedScoop),
      onScoopCreated: (scoop) => {
        layout.panels.scoops.refreshScoops();
        layout.refreshScoopSwitcher?.();
        if (!getSelectedScoop()) void selectScoop(scoop);
      },
      onScoopListUpdate: () => {
        layout.panels.scoops.refreshScoops();
        layout.refreshScoopSwitcher?.();
      },
      onIncomingMessage: (jid, msg) => handleIncomingMessage(jid, msg, layout, getSelectedScoop),
      onScoopMessagesReplaced: (jid, messages) => {
        if (getSelectedScoop()?.jid !== jid) return;
        layout.panels.chat.loadMessages(messages as unknown as ChatMessage[]);
      },
      onCompactionStateChange: (jid, state) => {
        if (getSelectedScoop()?.jid !== jid) return;
        layout.panels.chat.setCompactionState(state);
      },
      onReady: () => {
        log.info('Kernel worker ready, scoop count:', client.getScoops().length);
        const cone = client.getScoops().find((s) => s.isCone);
        if (cone && !getSelectedScoop()) void selectScoop(cone);
      },
    },
  });
  client = host.client;

  return {
    client,
    hostReady: host.ready,
    hostDispose: () => host.dispose(),
    selectScoop,
    syncThinkingButtonForScoop,
    disarmMigrationSplash,
  };
}

function handleStatus(
  jid: string,
  status: string,
  layout: Layout,
  getSelectedScoop: () => RegisteredScoop | null
): void {
  layout.panels.scoops.updateScoopStatus(jid, status as never);
  layout.updateScoopSwitcherStatus?.(jid, status as never);
  if (getSelectedScoop()?.jid !== jid) return;
  layout.setAgentProcessing(status === 'processing');
  if (status === 'processing') layout.panels.chat.setProcessing(true);
  else if (status === 'ready') layout.panels.chat.setProcessing(false);
}

function handleIncomingMessage(
  jid: string,
  message: { id: string; content: string; channel: string; timestamp: string | number },
  layout: Layout,
  getSelectedScoop: () => RegisteredScoop | null
): void {
  if (getSelectedScoop()?.jid !== jid) return;
  if (message.channel !== 'web' && isLickChannel(message.channel)) {
    layout.panels.chat.addLickMessage(
      message.id,
      message.content,
      message.channel as never,
      new Date(message.timestamp).getTime()
    );
  }
}
