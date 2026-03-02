/**
 * Type-level tests — verify the UI type contracts compile correctly.
 */

import { describe, it, expect } from 'vitest';
import type { AgentHandle, AgentEvent, ChatMessage, ToolCall, Session } from './types.js';

describe('UI types', () => {
  it('AgentHandle contract is well-formed', () => {
    // Verify the type can be implemented
    const handle: AgentHandle = {
      sendMessage(_text: string) {},
      onEvent(_cb: (event: AgentEvent) => void) {
        return () => {};
      },
      stop() {},
    };

    expect(handle.sendMessage).toBeDefined();
    expect(handle.onEvent).toBeDefined();
    expect(handle.stop).toBeDefined();
  });

  it('AgentEvent union covers all expected event types', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: '1' },
      { type: 'content_delta', messageId: '1', text: 'hello' },
      { type: 'content_done', messageId: '1' },
      { type: 'tool_use_start', messageId: '1', toolName: 'bash', toolInput: {} },
      { type: 'tool_result', messageId: '1', toolName: 'bash', result: 'ok' },
      { type: 'turn_end', messageId: '1' },
      { type: 'error', error: 'something failed' },
      { type: 'screenshot', base64: 'abc123' },
      { type: 'terminal_output', text: 'output' },
    ];

    expect(events).toHaveLength(9);
  });

  it('ChatMessage has required fields', () => {
    const msg: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };
    expect(msg.id).toBe('m1');
    expect(msg.role).toBe('user');
  });

  it('ChatMessage supports tool calls', () => {
    const tc: ToolCall = {
      id: 't1',
      name: 'read_file',
      input: { path: '/test' },
      result: 'file content',
    };
    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [tc],
    };
    expect(msg.toolCalls).toHaveLength(1);
  });

  it('Session has required fields', () => {
    const session: Session = {
      id: 's1',
      messages: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    expect(session.id).toBe('s1');
  });
});
