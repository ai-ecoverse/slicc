import { GuestUnresponsiveError, SandboxError, SandboxNotFoundError } from 'e2b';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type CloudError, isCloudError } from '../src/index.js';
import { createE2bSubstrate } from '../src/substrates/e2b.js';

// Only `Sandbox.connect` and `Sandbox.kill` are mocked; the error classes stay the SDK's real
// ones, so these tests exercise the same `instanceof` checks production does.
// No network, no API key: every connect resolves or rejects from the mock.
const { connectMock, killMock } = vi.hoisted(() => ({ connectMock: vi.fn(), killMock: vi.fn() }));

vi.mock('e2b', async (importOriginal) => {
  const actual = await importOriginal<typeof import('e2b')>();
  return { ...actual, Sandbox: { connect: connectMock, kill: killMock } };
});

/** The message e2b 2.63+ builds for a 409 `sandbox_snapshot_guest_agent_unresponsive`. */
function guestUnresponsive(): GuestUnresponsiveError {
  return new GuestUnresponsiveError(
    "Sandbox 'sbx-1' cannot be resumed with its memory: its snapshot was taken while the sandbox " +
      "guest agent was not responding. Resume the sandbox with `onResume: 'reboot'`."
  );
}

interface FakeCommandHandle {
  disconnect: ReturnType<typeof vi.fn>;
}

function fakeSandbox(sandboxId = 'sbx-1') {
  const proc: FakeCommandHandle = { disconnect: vi.fn(async () => {}) };
  return {
    sandboxId,
    proc,
    commands: { run: vi.fn(async () => proc) },
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

describe('e2b substrate connect: unresponsive guest (GuestUnresponsiveError)', () => {
  const substrate = createE2bSubstrate({ apiKey: 'test-key' });

  beforeEach(() => {
    connectMock.mockReset();
  });

  it('restores memory on a normal connect and never asks for a reboot', async () => {
    connectMock.mockResolvedValueOnce(fakeSandbox());

    const handle = await substrate.connect('sbx-1', { rebootIfUnresponsive: true });

    expect(handle.sandboxId).toBe('sbx-1');
    expect(handle.coldBooted).toBeUndefined();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock.mock.calls[0]?.[1]).not.toHaveProperty('onResume');
  });

  it('maps GuestUnresponsiveError to SANDBOX_UNRESPONSIVE when the caller did not opt in', async () => {
    connectMock.mockRejectedValueOnce(guestUnresponsive());

    const err = await rejection(substrate.connect('sbx-1'));

    expect(isCloudError(err)).toBe(true);
    const cloudErr = err as CloudError;
    expect(cloudErr.code).toBe('SANDBOX_UNRESPONSIVE');
    expect(cloudErr.details).toEqual({ sandboxId: 'sbx-1' });
    expect(cloudErr.message).toMatch(/sbx-1 is unresponsive/);
    expect(cloudErr.message).toMatch(/disk is intact/);
    // Without opt-in there is no second, reboot attempt.
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once with onResume: reboot and marks the handle coldBooted', async () => {
    connectMock.mockRejectedValueOnce(guestUnresponsive());
    connectMock.mockResolvedValueOnce(fakeSandbox());

    const handle = await substrate.connect('sbx-1', { rebootIfUnresponsive: true });

    expect(handle.coldBooted).toBe(true);
    expect(connectMock).toHaveBeenCalledTimes(2);
    // The first attempt is a plain memory restore, never a reboot.
    expect(connectMock.mock.calls[0]?.[1]).not.toHaveProperty('onResume');
    expect(connectMock.mock.calls[1]?.[0]).toBe('sbx-1');
    expect(connectMock.mock.calls[1]?.[1]).toMatchObject({
      apiKey: 'test-key',
      onResume: 'reboot',
      requestTimeoutMs: 120_000,
    });
  });

  it('recognizes the error by name when it comes from another copy of the SDK', async () => {
    const foreign = Object.assign(new Error('guest agent unresponsive'), {
      name: 'GuestUnresponsiveError',
    });
    connectMock.mockRejectedValueOnce(foreign);
    connectMock.mockResolvedValueOnce(fakeSandbox());

    const handle = await substrate.connect('sbx-1', { rebootIfUnresponsive: true });

    expect(handle.coldBooted).toBe(true);
  });

  it('reports a failed cold boot as SANDBOX_UNRESPONSIVE and does not retry again', async () => {
    connectMock.mockRejectedValueOnce(guestUnresponsive());
    connectMock.mockRejectedValueOnce(new SandboxError('boot timed out'));

    const err = await rejection(substrate.connect('sbx-1', { rebootIfUnresponsive: true }));

    expect(isCloudError(err)).toBe(true);
    expect((err as CloudError).code).toBe('SANDBOX_UNRESPONSIVE');
    expect((err as CloudError).message).toMatch(/Cold-booting it from its disk failed too/);
    expect((err as CloudError).message).toMatch(/boot timed out/);
    expect((err as CloudError).message).toMatch(/snapshot intact/);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a not-found error from the reboot attempt so kill can still clean up', async () => {
    const gone = new SandboxNotFoundError('Paused sandbox sbx-1 not found');
    connectMock.mockRejectedValueOnce(guestUnresponsive());
    connectMock.mockRejectedValueOnce(gone);

    const err = await rejection(substrate.connect('sbx-1', { rebootIfUnresponsive: true }));

    expect(err).toBe(gone);
  });

  it('passes other connect errors through untouched, without a reboot retry', async () => {
    const gone = new SandboxNotFoundError('Paused sandbox sbx-1 not found');
    connectMock.mockRejectedValueOnce(gone);

    const err = await rejection(substrate.connect('sbx-1', { rebootIfUnresponsive: true }));

    expect(err).toBe(gone);
    expect(isCloudError(err)).toBe(false);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});

describe('e2b substrate handle.spawn', () => {
  it('starts the command in the background with no command timeout, then detaches', async () => {
    const sbx = fakeSandbox();
    connectMock.mockReset();
    connectMock.mockResolvedValueOnce(sbx);
    const handle = await createE2bSubstrate({ apiKey: 'test-key' }).connect('sbx-1');

    await handle.spawn?.('/usr/local/bin/slicc-start');

    expect(sbx.commands.run).toHaveBeenCalledWith('/usr/local/bin/slicc-start', {
      background: true,
      timeoutMs: 0,
    });
    expect(sbx.proc.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('e2b substrate killById', () => {
  const substrate = createE2bSubstrate({ apiKey: 'test-key' });

  beforeEach(() => {
    connectMock.mockReset();
    killMock.mockReset();
  });

  it('deletes by ID through Sandbox.kill and never connects (no resume, no cold boot)', async () => {
    killMock.mockResolvedValueOnce(true);

    await expect(substrate.killById?.('sbx-1')).resolves.toBe(true);

    expect(killMock).toHaveBeenCalledWith('sbx-1', {
      apiKey: 'test-key',
      requestTimeoutMs: 120_000,
    });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('passes through false for a sandbox e2b does not know', async () => {
    killMock.mockResolvedValueOnce(false);

    await expect(substrate.killById?.('sbx-gone')).resolves.toBe(false);
  });
});
