import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitShellCommand, setShellTelemetrySink } from '../../src/shell/telemetry-hook.js';

describe('shell telemetry-hook', () => {
  beforeEach(() => {
    setShellTelemetrySink(null);
  });

  afterEach(() => {
    setShellTelemetrySink(null);
  });

  it('drops emits when no sink is registered', () => {
    expect(() => emitShellCommand('git')).not.toThrow();
  });

  it('routes emits to the registered sink', () => {
    const sink = vi.fn();
    setShellTelemetrySink(sink);

    emitShellCommand('git');
    emitShellCommand('ls');

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, 'git');
    expect(sink).toHaveBeenNthCalledWith(2, 'ls');
  });

  it('stops emitting after the sink is cleared', () => {
    const sink = vi.fn();
    setShellTelemetrySink(sink);
    emitShellCommand('git');
    setShellTelemetrySink(null);
    emitShellCommand('ls');

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('git');
  });

  it('replaces a previously registered sink', () => {
    const first = vi.fn();
    const second = vi.fn();
    setShellTelemetrySink(first);
    setShellTelemetrySink(second);

    emitShellCommand('node');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('node');
  });
});
