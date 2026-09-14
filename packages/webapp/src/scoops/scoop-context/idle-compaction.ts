import { createLogger } from '../../base/logger.js';
import { hasCompactionProgress } from '../../core/context-compaction.js';
import type { IdleCompactionSettings } from '../../core/idle-compaction-settings.js';
import type { Agent, AgentMessage } from '../../core/index.js';
import type { CompactFn } from './overflow-recovery.js';

const log = createLogger('idle-compaction');

export type IdleCompactionOutcome =
  | 'compacted'
  | 'cancelled'
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
  isEnabled: () => boolean;

  getSettings: () => IdleCompactionSettings;
  getAgent: () => Agent | null;
  isDisposed: () => boolean;

  isBusy: () => boolean;
  getCompactFn: () => CompactFn | null;
  getCompactionApiKey: () => string | undefined;

  estimateTokens: (messages: AgentMessage[]) => number;

  onCompacted: (info: { before: number; after: number }) => void;

  onDiscarded: (roundId: string) => void;
  folder: string;
}

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

  private round: AbortController | null = null;

  private rounds = 0;

  constructor(private readonly deps: IdleCompactionDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  get isArmed(): boolean {
    return this.timer !== null;
  }

  arm(): void {
    this.disarm();
    if (this.deps.isDisposed() || !this.deps.isEnabled() || !this.deps.getAgent()) return;
    const { idleMinutes } = this.deps.getSettings();

    const delay = Math.min(Math.max(1, idleMinutes * 60_000), 2_147_483_647);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, delay);
  }

  disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  cancel(): void {
    this.disarm();
    this.round?.abort();
  }

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

    const roundId = `idle-${Date.now().toString(36)}-${((this.rounds += 1)).toString(36)}`;
    const outcome = await this.runRound(agent, compactFn, messages, tokens, roundId);

    if (outcome !== 'compacted') {
      try {
        this.deps.onDiscarded(roundId);
      } catch (err) {
        log.warn('onDiscarded hook threw', {
          folder: this.deps.folder,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcome;
  }

  private async runRound(
    agent: Agent,
    compactFn: CompactFn,
    messages: AgentMessage[],
    tokens: number,
    roundId: string
  ): Promise<IdleCompactionOutcome> {
    const before = fingerprint(messages);
    const input = messages.slice();
    const round = new AbortController();
    this.round = round;
    this.running = true;
    let extractMemories: (() => Promise<void>) | null = null;
    log.info('Idle compaction round started', {
      folder: this.deps.folder,
      tokens,
      messageCount: input.length,
    });
    try {
      const compacted = await compactFn(input, round.signal, {
        force: true,
        trigger: 'idle',
        roundId,
        deferMemoryExtraction: (extract) => {
          extractMemories = extract;
        },
      });
      if (round.signal.aborted) return this.cancelled();
      const outcome = this.adopt(agent, before, input, compacted);

      if (outcome === 'compacted' && extractMemories) {
        void (extractMemories as () => Promise<void>)().catch((err) => {
          log.warn('Deferred memory extraction failed', {
            folder: this.deps.folder,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return outcome;
    } catch (err) {
      if (round.signal.aborted) return this.cancelled();
      log.warn('Idle compaction round failed (history untouched)', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    } finally {
      this.running = false;
      if (this.round === round) this.round = null;
    }
  }

  private cancelled(): IdleCompactionOutcome {
    log.info('Idle compaction round cancelled', { folder: this.deps.folder });
    return 'cancelled';
  }

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
