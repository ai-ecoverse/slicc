import { describe, expect, it, vi } from 'vitest';
import { NodeExitError } from '../../../src/kernel/realm/realm-node-shims.js';
import {
  formatUnhandledRejection,
  watchUnhandledRejections,
} from '../../../src/kernel/realm/realm-unhandled-rejections.js';

/** Node has no PromiseRejectionEvent: an Event carrying `reason`. */
function rejection(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

function setup(didExit = false) {
  const target = new EventTarget();
  const writeStderr = vi.fn();
  const recordExit = vi.fn();
  const watch = watchUnhandledRejections(target, {
    writeStderr,
    didExit: () => didExit,
    recordExit,
  });
  return { target, writeStderr, recordExit, watch };
}

describe('watchUnhandledRejections', () => {
  it('prints the stack and exits 1, like Node', async () => {
    const { target, writeStderr, recordExit, watch } = setup();
    const err = new Error('memory access out of bounds');
    const event = rejection(err);
    target.dispatchEvent(event);
    expect(writeStderr).toHaveBeenCalledWith(`${err.stack}\n`);
    expect(recordExit).toHaveBeenCalledWith(1);
    expect(event.defaultPrevented).toBe(true);
    await expect(watch.fatal).resolves.toBeUndefined();
  });

  it('stays quiet for process.exit() from async code', () => {
    const { target, writeStderr, recordExit } = setup();
    const event = rejection(new NodeExitError(3));
    target.dispatchEvent(event);
    expect(writeStderr).not.toHaveBeenCalled();
    expect(recordExit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('reports nothing after the program exited', () => {
    const { target, writeStderr, recordExit } = setup(true);
    target.dispatchEvent(rejection(new Error('late')));
    expect(writeStderr).not.toHaveBeenCalled();
    expect(recordExit).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', () => {
    const { target, writeStderr, watch } = setup();
    watch.dispose();
    target.dispatchEvent(rejection(new Error('after dispose')));
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it('is a no-op on a global without event listeners (in-process realm)', () => {
    const recordExit = vi.fn();
    const watch = watchUnhandledRejections(
      {},
      {
        writeStderr: vi.fn(),
        didExit: () => false,
        recordExit,
      }
    );
    expect(() => watch.dispose()).not.toThrow();
    expect(recordExit).not.toHaveBeenCalled();
  });
});

describe('formatUnhandledRejection', () => {
  it('uses the stack for errors and names other reasons', () => {
    const noStack = new TypeError('bad');
    noStack.stack = undefined;
    expect(formatUnhandledRejection(noStack)).toBe('TypeError: bad\n');
    expect(formatUnhandledRejection('boom')).toBe("Uncaught 'boom'\n");
    expect(formatUnhandledRejection(42)).toBe('Uncaught 42\n');
  });
});
