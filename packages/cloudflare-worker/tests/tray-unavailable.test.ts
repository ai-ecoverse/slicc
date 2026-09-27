import { describe, expect, it, vi } from 'vitest';
import worker, { handleWorkerRequest, type WorkerEnv } from '../src/index.js';
import { makeEnv } from './helpers/fake-env.js';

const RESET = 'Durable Object reset because its code was updated.';

function throwingHub(): WorkerEnv['TRAY_HUB'] {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    idFromString: (id: string) => ({ toString: () => id }) as DurableObjectId,
    newUniqueId: () => ({ toString: () => 'id' }) as DurableObjectId,
    get: () =>
      ({
        fetch: () => Promise.reject(new Error(RESET)),
      }) as unknown as DurableObjectStub,
  } as unknown as WorkerEnv['TRAY_HUB'];
}

function explodingHub(): WorkerEnv['TRAY_HUB'] {
  return {
    idFromName: () => {
      throw new Error('binding missing');
    },
    idFromString: () => {
      throw new Error('binding missing');
    },
    newUniqueId: () => {
      throw new Error('binding missing');
    },
    get: () => {
      throw new Error('binding missing');
    },
  } as unknown as WorkerEnv['TRAY_HUB'];
}

describe('tray durable object failures stay JSON', () => {
  it('answers a join bootstrap with 503 JSON when the tray object resets', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = makeEnv({ TRAY_HUB: throwingHub() });
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/join/11111111-1111-4111-8111-111111111111.abcdef', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.sliccy.ai' },
        body: JSON.stringify({ action: 'poll', controllerId: 'c', bootstrapId: 'b', cursor: 0 }),
      }),
      env
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('retry-after')).toBe('1');
    await expect(res.json()).resolves.toMatchObject({
      code: 'TRAY_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    expect(errors).toHaveBeenCalledWith('tray durable object fetch failed', RESET);
    errors.mockRestore();
  });

  it('answers POST /tray with 503 JSON when create resets the object', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = makeEnv({ TRAY_HUB: throwingHub() });
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'TRAY_TEMPORARILY_UNAVAILABLE' });
    vi.restoreAllMocks();
  });

  it('turns a throw outside the stub into JSON instead of rejecting', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = makeEnv({ TRAY_HUB: explodingHub() });
    const res = await worker.fetch(
      new Request('https://www.sliccy.ai/join/11111111-1111-4111-8111-111111111111.abcdef', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body).toMatchObject({
      code: 'TRAY_TEMPORARILY_UNAVAILABLE',
      retryable: true,
    });
    expect(body.error).not.toContain('1101');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
