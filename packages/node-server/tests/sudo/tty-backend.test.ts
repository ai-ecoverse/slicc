import type { Interface as ReadlineInterface } from 'readline';
import { describe, expect, it, vi } from 'vitest';
import { createTtyBackend, defaultRl } from '../../src/sudo/tty-backend.js';
import type { SudoApproveRequest } from '../../src/sudo/types.js';

const REQ: SudoApproveRequest = {
  kind: 'command',
  detail: 'rm -rf build',
  suggestedPattern: 'rm -rf*',
};

function fakeRl(answers: string[]) {
  let i = 0;
  const question = vi.fn((_q: string, cb: (a: string) => void) => cb(answers[i++] ?? ''));
  return {
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
  it('constructs the default readline interface', () => {
    const rl = defaultRl();
    expect(rl.question).toBeTypeOf('function');
    rl.close();
  });

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

  it('denies when readline throws', async () => {
    const rl = {
      question: vi.fn(() => {
        throw new Error('input closed');
      }) as unknown as ReadlineInterface['question'],
      close: vi.fn(),
    };
    const backend = createTtyBackend({
      output: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      createRl: () => rl,
    });
    expect(await backend.prompt(REQ)).toEqual({ decision: 'deny' });
    expect(rl.close).toHaveBeenCalledOnce();
  });
});
