import { describe, expect, it } from 'vitest';
import {
  ensurePromptLineStart,
  type PromptLineGuardTerminal,
} from '../../src/kernel/remote-terminal-view.js';

/**
 * Fake xterm capturing writes. Mirrors xterm's async write queue: every
 * callback is deferred to a macrotask, and `flushCursorX` (when set)
 * only takes effect once the first flush write's callback runs —
 * simulating queued-but-unparsed output bytes (#1583).
 */
function makeTerminal(options: { cursorX: number; flushCursorX?: number }) {
  const writes: string[] = [];
  const terminal: PromptLineGuardTerminal = {
    buffer: { active: { cursorX: options.cursorX } },
    write(data, callback) {
      writes.push(data);
      setTimeout(() => {
        if (options.flushCursorX !== undefined) {
          terminal.buffer.active.cursorX = options.flushCursorX;
          options.flushCursorX = undefined;
        }
        callback?.();
      }, 0);
    },
  };
  return { terminal, writes };
}

describe('ensurePromptLineStart (#1583)', () => {
  it('writes \\r\\n when a partial output line left the cursor mid-row', async () => {
    // `echo -n ABC123` → cursor sits at column 6 when the prompt redraws.
    const { terminal, writes } = makeTerminal({ cursorX: 6 });
    await ensurePromptLineStart(terminal);
    expect(writes).toEqual(['', '\r\n']);
  });

  it('leaves the row untouched when output ended with a newline', async () => {
    const { terminal, writes } = makeTerminal({ cursorX: 0 });
    await ensurePromptLineStart(terminal);
    expect(writes).toEqual(['']);
  });

  it('reads cursorX only after the flush barrier settles queued output', async () => {
    // Cursor reports column 0 now, but queued (unparsed) output will land
    // it at column 8 — the guard must wait for the flush write's callback
    // before deciding, or it would skip the newline and lose the line.
    const { terminal, writes } = makeTerminal({ cursorX: 0, flushCursorX: 8 });
    await ensurePromptLineStart(terminal);
    expect(writes).toEqual(['', '\r\n']);
  });
});
