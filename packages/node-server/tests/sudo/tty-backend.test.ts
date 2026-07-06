/**
 * Tests for the headless editable-TTY sudo backend using an injected readline
 * interface and a capturing output stream.
 */

import type { Interface as ReadlineInterface } from 'readline';
import { describe, expect, it, vi } from 'vitest';
import { createTtyBackend } from '../../src/sudo/tty-backend.js';
import type { SudoApproveRequest } from '../../src/sudo/types.js';

const REQ: SudoApproveRequest = {
  kind: 'command',
  detail: 'rm -rf build',
  suggestedPattern: 'rm -rf*',
};

/** Build a fake readline that answers queued responses in order. */
function fakeRl(answers: string[]) {
  let i = 0;
  const question = vi.fn((_q: string, cb: (a: string) => void) => cb(answers[i++] ?? ''));
  return {
    // The real `question` has overloads the fake doesn't implement; the cast
    // keeps the mock compatible with Pick<Interface, 'question' | 'close'>.
    question: question as unknown as ReadlineInterface['question'],
    close: vi.fn(),
  };
}

function makeBackend(answers: string[]) {
  const out = { write: vi.fn() } as unknown as NodeJS.WritableStream;
  const rl = fakeRl(answers);
  const backend = createTtyBackend({ output: out, createRl: () => rl });
  return { backend, rl, out };
}

describe('tty backend', () => {
  it('allows on "a"', async () => {
    const { backend } = makeBackend(['a']);
    expect(await backend.prompt(REQ)).toEqual({ decision: 'allow' });
  });

  it('denies on "d"', async () => {
    const { backend } = makeBackend(['d']);
    expect(await backend.prompt(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on any other input (fail closed)', async () => {
    const { backend } = makeBackend(['']);
    expect(await backend.prompt(REQ)).toEqual({ decision: 'deny' });
  });

  it('captures an edited Always pattern', async () => {
    const { backend } = makeBackend(['A', 'rm -rf build/*']);
    expect(await backend.prompt(REQ)).toEqual({ decision: 'always', pattern: 'rm -rf build/*' });
  });

  it('falls back to suggested when Always pattern is blank', async () => {
    const { backend } = makeBackend(['A', '']);
    expect(await backend.prompt(REQ)).toEqual({ decision: 'always', pattern: 'rm -rf*' });
  });

  it('closes the readline interface', async () => {
    const { backend, rl } = makeBackend(['d']);
    await backend.prompt(REQ);
    expect(rl.close).toHaveBeenCalled();
  });
});
