import { describe, expect, it, vi } from 'vitest';
import { AgentEventStream } from '../../../src/kernel/facade/agent-event-stream.js';

function textDelta(text: string) {
  return { type: 'agent-event', scoopJid: 'scoop-1', eventType: 'text_delta', text } as const;
}

describe('AgentEventStream', () => {
  it('tracks message state with no listeners', () => {
    const stream = new AgentEventStream();
    stream.publish(textDelta('before'));
    const events: Array<{ type: string; messageId?: string }> = [];
    stream.subscribe((_jid, event) =>
      events.push({
        type: event.type,
        messageId: 'messageId' in event ? event.messageId : undefined,
      })
    );

    stream.publish(textDelta('after'));

    expect(events.map((event) => event.type)).toEqual(['content_delta']);
    expect(events[0].messageId).toMatch(/^scoop-scoop-1-/);
  });

  it('does not synthesize turn_end and resets message gating', () => {
    const stream = new AgentEventStream();
    const types: string[] = [];
    stream.subscribe((_jid, event) => types.push(event.type));
    stream.publish(textDelta('first'));
    stream.publish({ type: 'agent-event', scoopJid: 'scoop-1', eventType: 'turn_end' });
    stream.publish(textDelta('next'));

    expect(types).toEqual(['message_start', 'content_delta', 'message_start', 'content_delta']);
  });

  it('isolates and logs a throwing listener before notifying later listeners', () => {
    const stream = new AgentEventStream();
    const healthy = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stream.subscribe(() => {
      throw new Error('listener failed');
    });
    stream.subscribe(healthy);

    stream.publish(textDelta('hello'));

    expect(healthy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
