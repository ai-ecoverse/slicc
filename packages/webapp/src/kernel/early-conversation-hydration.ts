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
