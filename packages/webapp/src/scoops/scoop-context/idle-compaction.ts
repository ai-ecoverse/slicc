/**
 * Compact-on-idle (feature flag `compact-on-idle`).
 *
 * Owns: the idle timer a root unit arms every time it settles into `ready`,
 * the two gates a round must pass (idle long enough, context large enough),
 * and the "did the thread move?" check that decides whether the compacted
 * history is adopted or thrown away.
 *
 * The round itself is the ordinary compaction path (`compactFn` with
 * `force`), the same one overflow recovery runs outside a turn — so the
 * transcript snapshot, the summary, the memory extraction and the UI states
 * all come for free. What this module adds is WHEN: a cone that the user has
 * walked away from with a large context gets its history summarized while
 * nobody is waiting, instead of paying for the summary call at the start of
 * the next turn. If the user comes back mid-round, the round's result is
 * discarded and the conversation continues exactly as it was.
 *
 * Roots only, by construction: the owner wires `isEnabled` to the unit's
 * role, and a scoop never arms.
 */

import { createLogger } from '../../base/logger.js';
import { hasCompactionProgress } from '../../core/context-compaction.js';
import type { IdleCompactionSettings } from '../../core/idle-compaction-settings.js';
import type { Agent, AgentMessage } from '../../core/index.js';
import type { CompactFn } from './overflow-recovery.js';

const log = createLogger('idle-compaction');

export type IdleCompactionOutcome =
  | 'compacted'
  | 'disabled'
  | 'no-agent'
  | 'busy'
  | 'already-running'
  | 'unavailable'
  | 'below-minimum'
  | 'thread-moved'
  | 'no-progress'
  | 'failed';

export interface IdleCompactionDeps {
  /** Flag on AND this unit is a root. Read live at every arm and fire. */
  isEnabled: () => boolean;
  /** Idle window + context floor, read live at every arm and fire. */
  getSettings: () => IdleCompactionSettings;
  getAgent: () => Agent | null;
  isDisposed: () => boolean;
  /** A prompt is active or the agent is streaming. */
  isBusy: () => boolean;
  getCompactFn: () => CompactFn | null;
  getCompactionApiKey: () => string | undefined;
  /** Same pricing the threshold trigger uses (`estimateConversationTokens`). */
  estimateTokens: (messages: AgentMessage[]) => number;
  /** The compacted history was adopted; persist it. */
  onCompacted: (info: { before: number; after: number }) => void;
  folder: string;
}

/**
 * Identity of a message list at a point in time. pi-agent-core appends IN
 * PLACE (`state.messages.push`), so the array reference alone proves
 * nothing; length and last element together catch every append, and the
 * reference catches a wholesale replace (compaction, `clear-chat`).
 */
interface ThreadFingerprint {
  ref: readonly AgentMessage[];
  length: number;
  last: AgentMessage | undefined;
}

function fingerprint(messages: readonly AgentMessage[]): ThreadFingerprint {
  return { ref: messages, length: messages.length, last: messages[messages.length - 1] };
}

function sameThread(a: ThreadFingerprint, current: readonly AgentMessage[]): boolean {
  return a.ref === current && a.length === current.length && a.last === current[current.length - 1];
}

export class IdleCompaction {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly deps: IdleCompactionDeps) {}

  /** A round is in flight (its LLM calls may take a while). */
  get isRunning(): boolean {
    return this.running;
  }

  /** A timer is armed and nothing has fired yet. */
  get isArmed(): boolean {
    return this.timer !== null;
  }

  /**
   * (Re)start the idle window. Called on every `ready` transition; a no-op
   * when the flag is off or there is no agent to compact yet (a deferred
   * init arms once the credential arrives and `ready` fires again).
   */
  arm(): void {
    this.disarm();
    if (this.deps.isDisposed() || !this.deps.isEnabled() || !this.deps.getAgent()) return;
    const { idleMinutes } = this.deps.getSettings();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, Math.max(1, idleMinutes) * 60_000);
  }

  /** Cancel a pending window. A round already in flight settles on its own. */
  disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one round now, subject to every gate but the timer. Exposed so the
   * fire path and tests share one implementation. Never throws.
   */
  async runNow(): Promise<IdleCompactionOutcome> {
    const gate = this.gate();
    if (gate !== null) return gate;
    const agent = this.deps.getAgent()!;
    const compactFn = this.deps.getCompactFn()!;
    const messages = agent.state.messages;
    const tokens = this.deps.estimateTokens(messages);
    const { minTokens } = this.deps.getSettings();
    if (tokens < minTokens) {
      log.info('Idle compaction skipped: context below the minimum', {
        folder: this.deps.folder,
        tokens,
        minTokens,
      });
      return 'below-minimum';
    }

    const before = fingerprint(messages);
    const input = messages.slice();
    this.running = true;
    log.info('Idle compaction round started', {
      folder: this.deps.folder,
      tokens,
      messageCount: input.length,
    });
    try {
      const compacted = await compactFn(input, undefined, { force: true, trigger: 'idle' });
      return this.adopt(agent, before, input, compacted);
    } catch (err) {
      log.warn('Idle compaction round failed (history untouched)', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    } finally {
      this.running = false;
    }
  }

  /** The reasons a round cannot even start, checked in order. */
  private gate(): IdleCompactionOutcome | null {
    if (this.deps.isDisposed() || !this.deps.isEnabled()) return 'disabled';
    if (this.running) return 'already-running';
    if (this.deps.isBusy()) return 'busy';
    const agent = this.deps.getAgent();
    if (!agent) return 'no-agent';
    if (!this.deps.getCompactFn() || !agent.state.model || !this.deps.getCompactionApiKey()) {
      return 'unavailable';
    }
    return null;
  }

  /**
   * The round is done — but only a thread that stood still the whole time
   * may take the result. Anything else (a prompt arrived, the agent was
   * swapped or disposed, the history was cleared) means the user came back,
   * and their conversation continues from where THEY left it.
   */
  private adopt(
    agent: Agent,
    before: ThreadFingerprint,
    input: AgentMessage[],
    compacted: AgentMessage[]
  ): IdleCompactionOutcome {
    if (
      this.deps.isDisposed() ||
      this.deps.getAgent() !== agent ||
      this.deps.isBusy() ||
      !sameThread(before, agent.state.messages)
    ) {
      log.info('Idle compaction discarded: the thread moved during the round', {
        folder: this.deps.folder,
      });
      return 'thread-moved';
    }
    if (!hasCompactionProgress(input, compacted)) {
      log.info('Idle compaction made no progress', { folder: this.deps.folder });
      return 'no-progress';
    }
    agent.state.messages = compacted;
    log.info('Idle compaction applied', {
      folder: this.deps.folder,
      before: input.length,
      after: compacted.length,
    });
    this.deps.onCompacted({ before: input.length, after: compacted.length });
    return 'compacted';
  }
}
