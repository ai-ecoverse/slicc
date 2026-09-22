/**
 * Boot wiring: show each unit's saved chat before scoop contexts exist.
 *
 * `orchestrator.init()` spends its long stretch creating those contexts one
 * after another. The conversation records are already readable before that
 * loop, and the panel is already listening, so the hook hydrates the bridge
 * buffers and pushes them. A failure here is not fatal — the same hydrate
 * still runs after init, and an unpublished transcript can still be pushed.
 */

export interface EarlyConversationHydrationOrchestrator {
  setOnConversationsReady(hook: () => Promise<void>): void;
}

export interface EarlyConversationHydrationBridge {
  hydrateBuffersFromRecords(): Promise<void>;
  publishHydratedTranscripts(): void;
}

export function wireEarlyConversationHydration(
  orchestrator: EarlyConversationHydrationOrchestrator,
  bridge: EarlyConversationHydrationBridge,
  warn: (err: unknown) => void = (err) => console.warn('Early conversation hydration failed', err)
): void {
  orchestrator.setOnConversationsReady(async () => {
    try {
      await bridge.hydrateBuffersFromRecords();
      bridge.publishHydratedTranscripts();
    } catch (err) {
      warn(err);
    }
  });
}
