import type { AgentMessage } from '../../core/index.js';
import { type Agent, createLogger } from '../../core/index.js';

const log = createLogger('scoop-context');

type RecoveryContentBlock = {
  type: string;
  text?: string;
  data?: string;
};
type RecoveryMessage = {
  role: string;
  content: RecoveryContentBlock[] | string;
};

const IMAGE_STRIP_WINDOW = 10;

export interface ImageRecoveryDeps {
  getAgent: () => Agent | null;
  onResponse: (text: string, isPartial: boolean) => void;
  onError: (message: string) => void;

  folder: string;
}

export class ImageRecovery {
  private active = false;

  constructor(private readonly deps: ImageRecoveryDeps) {}

  get isActive(): boolean {
    return this.active;
  }

  markSettled(): void {
    this.active = false;
  }

  recover(messages: AgentMessage[]): void {
    const agent = this.deps.getAgent();
    if (!agent) return;

    log.warn('Image processing error detected, attempting recovery', {
      folder: this.deps.folder,
      messageCount: messages.length,
    });

    this.active = true;

    this.deps.onResponse(
      'Image rejected by API — removing problematic images and continuing...',
      false
    );

    try {
      const trimmed = messages.slice(0, -1);
      const stripped = stripRecentImages(trimmed);

      agent.state.messages = trimmed;

      const explanation = `[System: An image was rejected by the API and has been removed from the conversation (${stripped} message(s) affected). The conversation continues without the image.]`;

      agent.prompt(explanation).catch((err) => {
        log.error('Image recovery re-prompt failed', {
          folder: this.deps.folder,
          error: err instanceof Error ? err.message : String(err),
        });
        this.fail(err);
      });
    } catch (err) {
      log.error('Image recovery failed', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.active = false;
    this.deps.onError(
      `Image error recovery failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function stripRecentImages(messages: AgentMessage[]): number {
  let stripped = 0;
  const limit = Math.max(0, messages.length - IMAGE_STRIP_WINDOW);

  for (let i = messages.length - 1; i >= limit; i--) {
    const msg = messages[i] as RecoveryMessage;
    if (!Array.isArray(msg.content)) continue;

    const hasImages = msg.content.some((block) => block.type === 'image');
    if (!hasImages) continue;

    const filtered = msg.content.filter((block) => block.type !== 'image');

    if (filtered.length === 0) {
      messages[i] = {
        ...msg,
        content: [{ type: 'text' as const, text: '[Image removed: rejected by API]' }],
      } as AgentMessage;
    } else {
      messages[i] = { ...msg, content: filtered } as AgentMessage;
    }
    stripped++;
  }
  return stripped;
}
