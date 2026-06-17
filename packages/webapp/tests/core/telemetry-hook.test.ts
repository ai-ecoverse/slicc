import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitAgentError, setAgentErrorTelemetrySink } from '../../src/core/telemetry-hook.js';

describe('agent-error telemetry-hook', () => {
  beforeEach(() => {
    setAgentErrorTelemetrySink(null);
  });

  afterEach(() => {
    setAgentErrorTelemetrySink(null);
  });

  it('drops emits when no sink is registered', () => {
    expect(() => emitAgentError('llm', 'rate_limit')).not.toThrow();
    expect(() => emitAgentError('tool', 'bash: failed')).not.toThrow();
  });

  it('routes emits to the registered sink with the typed source', () => {
    const sink = vi.fn();
    setAgentErrorTelemetrySink(sink);

    emitAgentError('llm', 'rate_limit');
    emitAgentError('tool', 'bash: command failed');

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, 'llm', 'rate_limit');
    expect(sink).toHaveBeenNthCalledWith(2, 'tool', 'bash: command failed');
  });

  it('stops emitting after the sink is cleared', () => {
    const sink = vi.fn();
    setAgentErrorTelemetrySink(sink);
    emitAgentError('llm', 'first');
    setAgentErrorTelemetrySink(null);
    emitAgentError('llm', 'dropped');

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('llm', 'first');
  });

  it('replaces a previously registered sink', () => {
    const first = vi.fn();
    const second = vi.fn();
    setAgentErrorTelemetrySink(first);
    setAgentErrorTelemetrySink(second);

    emitAgentError('llm', 'boom');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('llm', 'boom');
  });
});
