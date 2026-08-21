/**
 * Progress emitter: id allocation, per-id throttling, label scrubbing and
 * lazy sink resolution.
 *
 * The sink is looked up at emit time from the ambient tool execution context
 * (`getToolExecutionContext().onUpdate`) — the same trick `mount` uses — so
 * the shell stays ignorant of the UI and the human terminal (no tool context)
 * simply gets no events.
 *
 * Constraints (see the design doc's "Constraints to respect"):
 * - Schedules nothing: no timers, no microtask batching beyond the optional
 *   async label scrub. A throttled `update` is DROPPED, not delayed; the
 *   `end` event always carries the final state.
 * - O(1) per event: one map lookup per id, no per-tick string building.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getToolExecutionContext } from '../../base/tool-execution-context.js';
import { PROGRESS_CONTENT_TYPE, type ProgressEvent, type ProgressSink } from './types.js';

/** Maximum `update` events per second per id (start/end are never throttled). */
export const MAX_UPDATES_PER_SECOND = 4;
const MIN_UPDATE_GAP_MS = 1000 / MAX_UPDATES_PER_SECOND;

export interface ProgressEmitterOptions {
  /** Clock used for throttling; injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Explicit sink. When omitted, the sink is resolved per event from the
   * current tool execution context and events outside any tool call are
   * dropped.
   */
  sink?: ProgressSink;
  /**
   * Secret scrubber applied to `label` before the event leaves the emitter.
   * Labels are built from argv, so a `curl -H "Authorization: …"` would
   * otherwise leak into the progress card. Scrubbed once per distinct label
   * per id and cached;
   * a throwing scrubber withholds the label rather than passing it through.
   */
  scrubLabel?: (text: string) => Promise<string>;
}

const LABEL_WITHHELD = '[label withheld: secret scrub unavailable]';

interface IdState {
  lastUpdateAt: number;
  /** Label as last handed to `emit`; a change triggers a re-scrub. */
  rawLabel: string;
  /** Resolved scrubbed label (or pending promise) for `rawLabel`. */
  label: string | Promise<string>;
  /** Serializes async-scrubbed emits so `end` never overtakes `start`. */
  tail: Promise<void>;
}

/** Receives child-unit events while a script-level unit is active. */
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

  /** Allocate a fresh, process-unique progress id (`p<n>` or `<prefix>-<n>`). */
  allocateId(prefix = 'p'): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** True when some sink would receive events right now. Cheap pre-check for callers. */
  hasSink(): boolean {
    return this.resolveSink() !== null;
  }

  /**
   * Route every unit other than `aggregator.id` into the aggregator instead of
   * the sink: the chat UI shows one bar per tool call (see
   * `script-progress.ts`). `null` restores direct delivery.
   */
  setAggregator(aggregator: ProgressAggregator | null): void {
    this.aggregator = aggregator;
  }

  /**
   * Emit an event. `start` and `end` always pass; `update` is dropped when
   * the previous update for the same id was less than 250 ms ago. Returns
   * `true` when the event was forwarded (possibly asynchronously, if the
   * label had to be scrubbed first).
   */
  emit(event: ProgressEvent): boolean {
    const aggregator = this.aggregator;
    if (aggregator && event.id !== aggregator.id) {
      aggregator.onChild(event);
      return true;
    }
    const sink = this.resolveSink();
    if (!sink) {
      // Nobody listening: forget the id so a later `end` cannot leak state.
      if (event.phase === 'end') this.ids.delete(event.id);
      return false;
    }

    const state = this.ids.get(event.id);
    if (event.phase === 'update') {
      if (!state) return false; // update without start: ignore (never allocate)
      const t = this.now();
      if (t - state.lastUpdateAt < MIN_UPDATE_GAP_MS) return false;
      state.lastUpdateAt = t;
      this.deliver(state, sink, event);
      return true;
    }

    if (event.phase === 'start') {
      const fresh: IdState = {
        // Allow the first update right after start.
        lastUpdateAt: Number.NEGATIVE_INFINITY,
        rawLabel: event.label,
        label: this.scrubbed(event.label),
        tail: Promise.resolve(),
      };
      this.ids.set(event.id, fresh);
      this.deliver(fresh, sink, event);
      return true;
    }

    // end
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
      // Same shape trick as `showToolUI`: the partial-result union only names
      // text/image blocks; the UI side discriminates on `type`.
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
      // Labels may evolve ("for f (3/12)"); scrub the new text once.
      state.rawLabel = event.label;
      state.label = this.scrubbed(event.label);
    }
    const { label } = state;
    if (typeof label === 'string') {
      const shown = capLabel(label);
      sink(shown === event.label ? event : { ...event, label: shown });
      return;
    }
    // Label still being scrubbed: chain behind the previous emit for this id
    // so ordering is preserved, then cache the resolved label.
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

/**
 * Longest label handed to the UI. Applied by {@link capLabel} in `deliver`,
 * i.e. AFTER the secret scrub.
 */
export const MAX_LABEL_CHARS = 80;

/**
 * Cap a label for display.
 *
 * MUST run after the scrub, never before: the scrubbers replace WHOLE known
 * secret strings, so truncating first can cut a token in half and smuggle the
 * surviving prefix past the scrubber into the progress card (a `curl -H
 * "Authorization: Bearer …"` whose token straddles the cut). Every label
 * builder therefore returns the full text and only this function shortens it.
 */
export function capLabel(label: string, max = MAX_LABEL_CHARS): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Build a progress label from a command's argv. Arguments are joined with a
 * single space. Deliberately NOT truncated here — see {@link capLabel}.
 */
export function progressLabel(name: string, args: readonly string[]): string {
  return args.length ? `${name} ${args.join(' ')}` : name;
}
