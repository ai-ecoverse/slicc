/**
 * Recovery from an image the provider refused.
 *
 * Owns: the "recovery in progress" flag and the backward walk that strips
 * `image` content blocks out of the recent history before re-prompting.
 *
 * Changes when providers change what they reject about an image, or when the
 * trimming window changes. It shares only a flag with overflow recovery, and
 * conflating the two is what made `hasActiveRecovery` hard to reason about.
 */

import type { AgentMessage } from '../../core/index.js';
import { type Agent, createLogger } from '../../core/index.js';

const log = createLogger('scoop-context');

/**
 * Structural view of an `AgentMessage` used by the image recovery pass. It
 * walks every kind of message and only needs `role` plus a list of content
 * blocks discriminated by `type` — narrower than the full union of pi-ai
 * message shapes, but enough to do the trimming safely without `any`.
 */
type RecoveryContentBlock = {
  type: string;
  text?: string;
  data?: string;
};
type RecoveryMessage = {
  role: string;
  content: RecoveryContentBlock[] | string;
};

/** How far back from the error the pass strips image blocks. */
const IMAGE_STRIP_WINDOW = 10;

export interface ImageRecoveryDeps {
  getAgent: () => Agent | null;
  onResponse: (text: string, isPartial: boolean) => void;
  onError: (message: string) => void;
  /** Unit folder, for log correlation only. */
  folder: string;
}

export class ImageRecovery {
  private active = false;

  constructor(private readonly deps: ImageRecoveryDeps) {}

  get isActive(): boolean {
    return this.active;
  }

  /** A terminal `agent_end` settles a recovery that was in flight. */
  markSettled(): void {
    this.active = false;
  }

  /**
   * Recover from an image processing error by stripping ImageContent blocks
   * from recent messages and re-prompting the agent.
   */
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
      // Remove the error assistant message (last)
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

/**
 * Strip every `image` block from the last {@link IMAGE_STRIP_WINDOW} messages
 * IN PLACE, replacing an all-image message with a placeholder so the turn
 * structure survives. Returns how many messages were rewritten.
 */
function stripRecentImages(messages: AgentMessage[]): number {
  let stripped = 0;
  const limit = Math.max(0, messages.length - IMAGE_STRIP_WINDOW);

  for (let i = messages.length - 1; i >= limit; i--) {
    const msg = messages[i] as RecoveryMessage;
    if (!Array.isArray(msg.content)) continue;

    const hasImages = msg.content.some((block) => block.type === 'image');
    if (!hasImages) continue;

    // Remove image blocks, keep text blocks
    const filtered = msg.content.filter((block) => block.type !== 'image');

    if (filtered.length === 0) {
      // All content was images — replace with placeholder
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
