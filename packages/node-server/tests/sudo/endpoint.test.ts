/**
 * Tests for POST /api/sudo-approve. The backend is injected so no real dialog
 * is raised; loopback guard + validation + fail-closed behavior are asserted.
 */

import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { registerSudoApproveEndpoint } from '../../src/sudo/endpoint.js';
import type { SudoBackend, SudoDecision } from '../../src/sudo/types.js';

async function makeRequest(app: express.Express, body?: unknown): Promise<Response> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const url = `http://127.0.0.1:${addr.port}/api/sudo-approve`;
    const options: RequestInit = { method: 'POST' };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    return await fetch(url, options);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function backendReturning(decision: SudoDecision): SudoBackend {
  return { name: 'test', prompt: vi.fn(async () => decision) };
}

describe('POST /api/sudo-approve', () => {
  it('returns the backend decision', async () => {
    const app = express();
    registerSudoApproveEndpoint(app, {
      backend: backendReturning({ decision: 'always', pattern: 'git push*' }),
    });
    const res = await makeRequest(app, {
      kind: 'command',
      detail: 'git push origin main',
      suggestedPattern: 'git push*',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('rejects an invalid kind with 400', async () => {
    const app = express();
    registerSudoApproveEndpoint(app, { backend: backendReturning({ decision: 'allow' }) });
    const res = await makeRequest(app, { kind: 'nope', detail: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid sudo-approve payload');
  });

  it('rejects a missing detail with 400', async () => {
    const app = express();
    registerSudoApproveEndpoint(app, { backend: backendReturning({ decision: 'allow' }) });
    const res = await makeRequest(app, { kind: 'command', detail: '' });
    expect(res.status).toBe(400);
  });

  it('defaults suggestedPattern to detail when omitted', async () => {
    const app = express();
    const backend = backendReturning({ decision: 'allow' });
    registerSudoApproveEndpoint(app, { backend });
    await makeRequest(app, { kind: 'read', detail: '/shared/secrets/k' });
    expect(backend.prompt).toHaveBeenCalledWith({
      kind: 'read',
      detail: '/shared/secrets/k',
      suggestedPattern: '/shared/secrets/k',
    });
  });

  it('fails closed (deny) when the backend throws', async () => {
    const app = express();
    const warn = vi.fn();
    registerSudoApproveEndpoint(app, {
      warn,
      backend: {
        name: 'boom',
        prompt: vi.fn(async () => {
          throw new Error('dialog crashed');
        }),
      },
    });
    const res = await makeRequest(app, { kind: 'command', detail: 'x', suggestedPattern: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: 'deny' });
    expect(warn).toHaveBeenCalled();
  });
});
