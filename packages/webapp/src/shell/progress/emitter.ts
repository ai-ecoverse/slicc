import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getToolExecutionContext } from '../../base/tool-execution-context.js';
import { PROGRESS_CONTENT_TYPE, type ProgressEvent, type ProgressSink } from './types.js';

export const MAX_UPDATES_PER_SECOND = 4;
const MIN_UPDATE_GAP_MS = 1000 / MAX_UPDATES_PER_SECOND;

export interface ProgressEmitterOptions {
  now?: () => number;

  sink?: ProgressSink;

  scrubLabel?: (text: string) => Promise<string>;
}

const LABEL_WITHHELD = '[label withheld: secret scrub unavailable]';

interface IdState {
  lastUpdateAt: number;

  rawLabel: string;

  label: string | Promise<string>;

  tail: Promise<void>;
}

export interface ProgressAggregator {
  readonly id: string;
  onChild(event: ProgressEvent): void;
}

export class ProgressEmitter {
  private aggregator: ProgressAggregator | null = null;
  private readonly now: () => number;
  private readonly explicitSink: ProgressSink | undefined;
  private readonly scrubLabel: ((text: string) => Promise<string>) | undefined;
  private readonly ids = new Map<string, IdState>();
  private seq = 0;

  constructor(options: ProgressEmitterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.explicitSink = options.sink;
    this.scrubLabel = options.scrubLabel;
  }

  allocateId(prefix = 'p'): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  hasSink(): boolean {
    return this.resolveSink() !== null;
  }

  setAggregator(aggregator: ProgressAggregator | null): void {
    this.aggregator = aggregator;
  }

  emit(event: ProgressEvent): boolean {
    const aggregator = this.aggregator;
    if (aggregator && event.id !== aggregator.id) {
      aggregator.onChild(event);
      return true;
    }
    const sink = this.resolveSink();
    if (!sink) {
      if (event.phase === 'end') this.ids.delete(event.id);
      return false;
    }

    const state = this.ids.get(event.id);
    if (event.phase === 'update') {
      if (!state) return false;
      const t = this.now();
      if (t - state.lastUpdateAt < MIN_UPDATE_GAP_MS) return false;
      state.lastUpdateAt = t;
      this.deliver(state, sink, event);
      return true;
    }

    if (event.phase === 'start') {
      const fresh: IdState = {
        lastUpdateAt: Number.NEGATIVE_INFINITY,
        rawLabel: event.label,
        label: this.scrubbed(event.label),
        tail: Promise.resolve(),
      };
      this.ids.set(event.id, fresh);
      this.deliver(fresh, sink, event);
      return true;
    }

    if (!state) return false;
    this.ids.delete(event.id);
    this.deliver(state, sink, event);
    return true;
  }

  private resolveSink(): ProgressSink | null {
    if (this.explicitSink) return this.explicitSink;
    const ctx = getToolExecutionContext();
    if (!ctx) return null;
    const onUpdate = ctx.onUpdate;
    return (progress) => {
      onUpdate({
        content: [{ type: PROGRESS_CONTENT_TYPE, progress }],
      } as unknown as AgentToolResult<unknown>);
    };
  }

  private scrubbed(label: string): string | Promise<string> {
    return this.scrubLabel ? scrubSafely(this.scrubLabel, label) : label;
  }

  private deliver(state: IdState, sink: ProgressSink, event: ProgressEvent): void {
    if (event.label !== state.rawLabel) {
      state.rawLabel = event.label;
      state.label = this.scrubbed(event.label);
    }
    const { label } = state;
    if (typeof label === 'string') {
      const shown = capLabel(label);
      sink(shown === event.label ? event : { ...event, label: shown });
      return;
    }

    state.tail = state.tail.then(async () => {
      const resolved = await label;
      state.label = resolved;
      sink({ ...event, label: capLabel(resolved) });
    });
  }
}

async function scrubSafely(
  scrub: (text: string) => Promise<string>,
  label: string
): Promise<string> {
  if (!label) return label;
  try {
    return await scrub(label);
  } catch {
    return LABEL_WITHHELD;
  }
}

export const MAX_LABEL_CHARS = 80;

export function capLabel(label: string, max = MAX_LABEL_CHARS): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function progressLabel(name: string, args: readonly string[]): string {
  return args.length ? `${name} ${args.join(' ')}` : name;
}
