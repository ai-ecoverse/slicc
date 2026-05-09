/**
 * Tests for the terminal protocol envelope types and guards.
 *
 * The runtime surface is small (two type-guards). The real value of
 * the file is the typed envelopes themselves, which Phase 2b step
 * 3+ uses to wire `terminal-view` (panel) ⇄ session bridge (worker).
 */

import { describe, it, expect } from 'vitest';
import {
  isTerminalControlMsg,
  isTerminalEventMsg,
  type TerminalControlMsg,
  type TerminalEventMsg,
} from '../../src/shell/terminal-protocol.js';

describe('terminal-protocol type guards', () => {
  it('isTerminalControlMsg accepts valid control envelopes', () => {
    const cases: TerminalControlMsg[] = [
      { type: 'terminal-open', sid: 's1' },
      { type: 'terminal-close', sid: 's1' },
      { type: 'terminal-stdin', sid: 's1', data: 'ls\n' },
      { type: 'terminal-exec', sid: 's1', execId: 'e1', command: 'echo' },
      { type: 'terminal-signal', sid: 's1', signal: 'SIGINT' },
      { type: 'terminal-resize', sid: 's1', cols: 80, rows: 24 },
    ];
    for (const c of cases) expect(isTerminalControlMsg(c)).toBe(true);
  });

  it('isTerminalControlMsg rejects unrelated shapes', () => {
    expect(isTerminalControlMsg(null)).toBe(false);
    expect(isTerminalControlMsg(undefined)).toBe(false);
    expect(isTerminalControlMsg({})).toBe(false);
    expect(isTerminalControlMsg({ type: 'agent-event' })).toBe(false);
    expect(isTerminalControlMsg('not an object')).toBe(false);
  });

  it('isTerminalEventMsg accepts valid event envelopes', () => {
    const cases: TerminalEventMsg[] = [
      { type: 'terminal-output', sid: 's1', stream: 'stdout', data: 'hi' },
      {
        type: 'terminal-media-preview',
        sid: 's1',
        path: '/tmp/pic.png',
        mediaType: 'image/png',
        data: 'base64...',
      },
      { type: 'terminal-exit', sid: 's1', execId: 'e1', exitCode: 0 },
      { type: 'terminal-cleared', sid: 's1' },
      { type: 'terminal-status', sid: 's1', state: 'opened' },
    ];
    for (const c of cases) expect(isTerminalEventMsg(c)).toBe(true);
  });

  it('isTerminalEventMsg rejects unrelated shapes', () => {
    expect(isTerminalEventMsg(null)).toBe(false);
    expect(isTerminalEventMsg({ type: 'terminal-stdin' })).toBe(false);
    expect(isTerminalEventMsg({ type: 'agent-event' })).toBe(false);
  });

  it('control and event sets are disjoint', () => {
    const open: TerminalControlMsg = { type: 'terminal-open', sid: 's1' };
    const out: TerminalEventMsg = {
      type: 'terminal-output',
      sid: 's1',
      stream: 'stdout',
      data: '',
    };
    expect(isTerminalControlMsg(open)).toBe(true);
    expect(isTerminalEventMsg(open)).toBe(false);
    expect(isTerminalControlMsg(out)).toBe(false);
    expect(isTerminalEventMsg(out)).toBe(true);
  });
});
