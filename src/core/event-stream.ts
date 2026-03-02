/**
 * EventStream — async iterable event stream with result promise.
 *
 * Ported from pi-mono's @mariozechner/pi-ai EventStream.
 * Implements push-pull queue pattern for efficient async delivery.
 */

import type { AssistantMessage, AssistantMessageEvent } from './types.js';

/**
 * Generic async iterable event stream.
 *
 * Events are pushed by producers and pulled by consumers via for-await-of.
 * Completes when isComplete(event) returns true. The result is extracted
 * from the completing event via extractResult().
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;
  private resultPromise: Promise<R>;
  private resolveResult!: (value: R) => void;
  private rejectResult!: (reason: unknown) => void;

  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.resultPromise = new Promise<R>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  /** Push an event into the stream. */
  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      // Deliver event to waiting consumer or queue it
      if (this.waiters.length > 0) {
        this.waiters.shift()!({ value: event, done: false });
      } else {
        this.queue.push(event);
      }
      // Signal completion to any remaining waiters
      for (const waiter of this.waiters) {
        waiter({ value: undefined as any, done: true });
      }
      this.waiters = [];
      this.resolveResult(this.extractResult(event));
      return;
    }

    if (this.waiters.length > 0) {
      this.waiters.shift()!({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /** End the stream with an optional result. */
  end(result?: R): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined as any, done: true });
    }
    this.waiters = [];
    if (result !== undefined) {
      this.resolveResult(result);
    }
  }

  /** Get the final result when the stream completes. */
  result(): Promise<R> {
    return this.resultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        if (this.isComplete(event)) return;
      } else if (this.done) {
        return;
      } else {
        // Wait for next event
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
        if (result.done) return;
        yield result.value;
        if (this.isComplete(result.value)) return;
      }
    }
  }
}

/**
 * AssistantMessageEventStream — typed EventStream for LLM streaming.
 *
 * Completes on "done" or "error" events.
 */
export class AssistantMessageEventStreamImpl
  extends EventStream<AssistantMessageEvent, AssistantMessage>
{
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message;
        if (event.type === 'error') return event.error;
        throw new Error('Unexpected completion event');
      },
    );
  }
}
