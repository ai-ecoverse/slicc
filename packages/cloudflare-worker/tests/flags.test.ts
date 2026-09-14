import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { makeEnv } from './helpers/fake-env.js';

const FEATURE_FLAGS = {
  base: { 'experimental-settings': 'on', theme: 'stable' },
  floats: {
    standalone: {},
    cherry: { 'experimental-settings': 'off' },
  },
};

class FakeCache {
  readonly keys: string[] = [];
  private readonly responses = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    this.keys.push(request.url);
    return this.responses.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.keys.push(request.url);
    this.responses.set(request.url, response.clone());
  }
}

function request(float?: string, origin?: string): Request {
  const url = new URL('https://www.sliccy.ai/api/flags');
  if (float) url.searchParams.set('float', float);
  return new Request(url, { headers: origin ? { Origin: origin } : undefined });
}

async function flags(float?: string, config: unknown = FEATURE_FLAGS): Promise<Response> {
  return handleWorkerRequest(request(float), makeEnv({ FEATURE_FLAGS: config }));
}

describe('GET /api/flags', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).caches;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).caches;
  });

  it('overlays per-float values on the base string map', async () => {
    const standalone = await flags('standalone');
    await expect(standalone.json()).resolves.toEqual({
      float: 'standalone',
      flags: { 'experimental-settings': 'on', theme: 'stable' },
    });

    const cherry = await flags('cherry');
    await expect(cherry.json()).resolves.toEqual({
      float: 'cherry',
      flags: { 'experimental-settings': 'off', theme: 'stable' },
    });
  });

  it('uses the default profile for missing and unknown floats', async () => {
    await expect((await flags()).json()).resolves.toEqual({
      float: 'default',
      flags: { 'experimental-settings': 'on', theme: 'stable' },
    });
    await expect((await flags('unknown')).json()).resolves.toEqual({
      float: 'default',
      flags: { 'experimental-settings': 'on', theme: 'stable' },
    });
  });

  it('falls back to the valid base map when a float overlay is malformed', async () => {
    const response = await flags('cherry', {
      base: { 'experimental-settings': 'on', cohort: 'base' },
      floats: { cherry: { 'experimental-settings': false } },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      float: 'default',
      flags: { 'experimental-settings': 'on', cohort: 'base' },
    });
  });

  it('never fails when the entire config is malformed', async () => {
    const response = await flags('cherry', 'not-an-object');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      float: 'default',
      flags: { 'experimental-settings': 'on' },
    });
  });

  it('mirrors OAuth CORS and caches independently by resolved float', async () => {
    const cache = new FakeCache();
    (globalThis as Record<string, unknown>).caches = { default: cache };
    const env = makeEnv({ FEATURE_FLAGS });

    const standalone = await handleWorkerRequest(
      request('standalone', 'http://localhost:5710'),
      env
    );
    expect(standalone.headers.get('access-control-allow-origin')).toBe('http://localhost:5710');
    expect(standalone.headers.get('vary')).toBe('Origin');
    expect(standalone.headers.get('cache-control')).toBe('public, max-age=300');

    const cached = await handleWorkerRequest(request('standalone', 'http://localhost:5720'), env);
    expect(cached.headers.get('access-control-allow-origin')).toBe('http://localhost:5720');
    const cherry = await handleWorkerRequest(request('cherry'), env);
    expect(cherry.status).toBe(200);

    expect(cache.keys.some((key) => key.endsWith('/api/flags?float=standalone'))).toBe(true);
    expect(cache.keys.some((key) => key.endsWith('/api/flags?float=cherry'))).toBe(true);
  });
});
