import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

import {
  detectRuntime,
  originOf,
  verifyConnection,
} from '../../src/providers/built-in/local-llm.js';

describe('originOf', () => {
  it('strips /v1 suffix', () => {
    expect(originOf('http://localhost:11434/v1')).toBe('http://localhost:11434');
  });

  it('handles trailing slash', () => {
    expect(originOf('http://localhost:1234/v1/')).toBe('http://localhost:1234');
  });

  it('handles no path', () => {
    expect(originOf('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('falls back gracefully on a malformed URL', () => {
    expect(originOf('not-a-url/v1')).toBe('not-a-url');
  });
});

describe('detectRuntime', () => {
  beforeEach(() => storage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('identifies Ollama via /api/version', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.5.4' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await detectRuntime('http://localhost:11434/v1');
    expect(info.kind).toBe('ollama');
    expect(info.version).toBe('0.5.4');
  });

  it('identifies LM Studio via /api/v0 with object: list', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/v0/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await detectRuntime('http://localhost:1234/v1');
    expect(info.kind).toBe('lmstudio');
  });

  it('identifies llama.cpp via /props build_info', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/props')) {
        return new Response(JSON.stringify({ build_info: { version: 'b1234' } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await detectRuntime('http://localhost:8080/v1');
    expect(info.kind).toBe('llamacpp');
    expect(info.version).toBe('b1234');
  });

  it('does NOT identify LM Studio when /api/v0/models returns the wrong shape', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/v0/models')) {
        return new Response(JSON.stringify({ models: ['foo'] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await detectRuntime('http://localhost:9999/v1');
    expect(info.kind).toBe('unknown');
  });

  it('falls back to port heuristic when no fingerprint matches', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await detectRuntime('http://localhost:11434/v1')).kind).toBe('ollama');
    expect((await detectRuntime('http://localhost:1234/v1')).kind).toBe('lmstudio');
    expect((await detectRuntime('http://localhost:8000/v1')).kind).toBe('vllm');
    expect((await detectRuntime('http://localhost:1337/v1')).kind).toBe('jan');
    expect((await detectRuntime('http://localhost:9999/v1')).kind).toBe('unknown');
  });

  it('returns unknown when fetch always throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await detectRuntime('http://localhost:9999/v1');
    expect(info.kind).toBe('unknown');
  });
});

describe('verifyConnection', () => {
  beforeEach(() => storage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('reports ok with discovered models on success', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.5.4' }), { status: 200 });
      }
      if (u.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder:14b' }] }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyConnection('http://localhost:11434/v1');
    expect(result.ok).toBe(true);
    expect(result.runtime.kind).toBe('ollama');
    expect(result.models).toEqual(['llama3.1:8b', 'qwen2.5-coder:14b']);
  });

  it('diagnoses Ollama CORS errors with an actionable hint', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);

      if (u.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.5.4' }), { status: 200 });
      }
      throw new Error('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyConnection('http://localhost:11434/v1');
    expect(result.ok).toBe(false);
    expect(result.runtime.kind).toBe('ollama');
    expect(result.error?.kind).toBe('cors');
    expect(result.error?.hint).toContain('OLLAMA_ORIGINS');

    expect(result.error?.hint).not.toContain('com.ollama.ollama.plist');
  });

  it('discovers models even when the user typed the host without /v1', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.5.4' }), { status: 200 });
      }
      if (u === 'http://localhost:11434/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }), { status: 200 });
      }

      if (u === 'http://localhost:11434/models') {
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyConnection('http://localhost:11434');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['llama3.1:8b']);
  });

  it('leaves an explicit /v1 path alone (does not double up)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/version')) return new Response('not found', { status: 404 });
      if (u === 'http://localhost:1234/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'gemma' }] }), { status: 200 });
      }

      if (u === 'http://localhost:1234/v1/v1/models') {
        return new Response('regressed', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyConnection('http://localhost:1234/v1');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gemma']);
  });

  it('diagnoses unknown-runtime connection failures as connection errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyConnection('http://localhost:9999/v1');
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('connection');
  });

  it('diagnoses 401/403 as auth errors', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/version')) return new Response('not found', { status: 404 });
      if (u.endsWith('/v1/models')) return new Response('Unauthorized', { status: 401 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyConnection('http://localhost:8080/v1');
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('auth');
  });
});
