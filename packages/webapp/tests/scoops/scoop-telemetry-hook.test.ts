import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emitScoopLifecycle,
  setScoopTelemetrySink,
} from '../../src/scoops/scoop-telemetry-hook.js';

describe('scoop telemetry-hook', () => {
  beforeEach(() => {
    setScoopTelemetrySink(null);
  });

  afterEach(() => {
    setScoopTelemetrySink(null);
  });

  it('drops emits when no sink is registered', () => {
    expect(() => emitScoopLifecycle('spawn', 'researcher')).not.toThrow();
    expect(() => emitScoopLifecycle('error', 'researcher', 'boom')).not.toThrow();
  });

  it('routes lifecycle events to the registered sink', () => {
    const sink = vi.fn();
    setScoopTelemetrySink(sink);

    emitScoopLifecycle('spawn', 'researcher');
    emitScoopLifecycle('feed', 'researcher');
    emitScoopLifecycle('complete', 'researcher');
    emitScoopLifecycle('error', 'researcher', 'oops');

    expect(sink).toHaveBeenCalledTimes(4);
    expect(sink).toHaveBeenNthCalledWith(1, 'spawn', 'researcher', undefined);
    expect(sink).toHaveBeenNthCalledWith(2, 'feed', 'researcher', undefined);
    expect(sink).toHaveBeenNthCalledWith(3, 'complete', 'researcher', undefined);
    expect(sink).toHaveBeenNthCalledWith(4, 'error', 'researcher', 'oops');
  });

  it('stops emitting after the sink is cleared', () => {
    const sink = vi.fn();
    setScoopTelemetrySink(sink);
    emitScoopLifecycle('spawn', 'a');
    setScoopTelemetrySink(null);
    emitScoopLifecycle('spawn', 'b');

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('spawn', 'a', undefined);
  });

  it('replaces a previously registered sink', () => {
    const first = vi.fn();
    const second = vi.fn();
    setScoopTelemetrySink(first);
    setScoopTelemetrySink(second);

    emitScoopLifecycle('feed', 'planner');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('feed', 'planner', undefined);
  });
});
