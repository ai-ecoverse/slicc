import { expect, test, vi } from 'vitest';
import {
  SYNC_EXEC_MAX_TIMEOUT_MS,
  SYNC_EXEC_RESPONSE_MARGIN_MS,
} from '../../src/kernel/realm/sync-fs-wire.js';
import {
  errnoToStatus,
  handleSyncFsRequest,
  parseSyncFsRequest,
  type SyncFsSwChannelLike,
} from '../../src/ui/sync-fs-sw-handler.js';

type FakeResult =
  | { ok: true; kind: 'bytes'; bytes: Uint8Array }
  | { ok: true; kind: 'void' }
  | { ok: true; kind: 'json'; json: unknown }
  | { ok: false; errno: string; message?: string };

function respondingChannel(
  responder: (req: Record<string, unknown>) => FakeResult | null
): SyncFsSwChannelLike {
  const listeners = new Set<(e: MessageEvent) => void>();
  const emit = (data: unknown): void => {
    for (const l of [...listeners]) l({ data } as MessageEvent);
  };
  return {
    postMessage: (data: unknown) => {
      const req = data as Record<string, unknown>;
      if (req?.type !== 'sync-fs-req') return;
      queueMicrotask(() => emit({ type: 'sync-fs-ack', id: req.id }));
      const result = responder(req);
      if (result) queueMicrotask(() => emit({ type: 'sync-fs-res', id: req.id, ...result }));
    },
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
  };
}

function deferredChannel(delayMs: number, result: FakeResult): SyncFsSwChannelLike {
  const listeners = new Set<(e: MessageEvent) => void>();
  const emit = (data: unknown): void => {
    for (const l of [...listeners]) l({ data } as MessageEvent);
  };
  return {
    postMessage: (data: unknown) => {
      const req = data as Record<string, unknown>;
      if (req?.type !== 'sync-fs-req') return;
      queueMicrotask(() => emit({ type: 'sync-fs-ack', id: req.id }));
      setTimeout(() => emit({ type: 'sync-fs-res', id: req.id, ...result }), delayMs);
    },
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
  };
}

test('ok read → 200 with raw bytes body', async () => {
  const ch = respondingChannel(() => ({
    ok: true,
    kind: 'bytes',
    bytes: new TextEncoder().encode('hi'),
  }));
  const res = await handleSyncFsRequest([ch], { token: 't', op: 'read', path: '/workspace/a.txt' });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-slicc-fs')).toBe('1');
  expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe('hi');
});

test('ok write → 200 empty body', async () => {
  const ch = respondingChannel(() => ({ ok: true, kind: 'void' }));
  const body = new TextEncoder().encode('x');
  const res = await handleSyncFsRequest([ch], { token: 't', op: 'write', path: '/w/b.txt', body });
  expect(res.status).toBe(200);
});

test('json result → 200 application/json body (phase-2 metadata is not dropped)', async () => {
  const payload = { isFile: true, isDirectory: false, size: 3 };
  const ch = respondingChannel(() => ({ ok: true, kind: 'json', json: payload }));
  const res = await handleSyncFsRequest([ch], { token: 't', op: 'read', path: '/workspace/a.txt' });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('x-slicc-fs')).toBe('1');
  expect(await res.json()).toEqual(payload);
});

test('errno ENOENT → 404 + x-slicc-fs-errno header', async () => {
  const ch = respondingChannel(() => ({ ok: false, errno: 'ENOENT', message: 'nope' }));
  const res = await handleSyncFsRequest([ch], { token: 't', op: 'read', path: '/missing' });
  expect(res.status).toBe(404);
  expect(res.headers.get('x-slicc-fs-errno')).toBe('ENOENT');
});

test('errno EACCES → 403 (escape / bad token surfaces as 403)', async () => {
  const ch = respondingChannel(() => ({ ok: false, errno: 'EACCES', message: 'denied' }));
  const res = await handleSyncFsRequest([ch], { token: 'bad', op: 'read', path: '/secret' });
  expect(res.status).toBe(403);
  expect(res.headers.get('x-slicc-fs-errno')).toBe('EACCES');
});

test('timeout / no responder → 503 + EIO (fail closed, never hangs)', async () => {
  const silent: SyncFsSwChannelLike = {
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const res = await handleSyncFsRequest(
    [silent],
    { token: 't', op: 'read', path: '/x' },
    { timeoutMs: 40, retryIntervalMs: 10 }
  );
  expect(res.status).toBe(503);
  expect(res.headers.get('x-slicc-fs-errno')).toBe('EIO');
});

test('errnoToStatus maps the known codes', () => {
  expect(errnoToStatus('ENOENT')).toBe(404);
  expect(errnoToStatus('EACCES')).toBe(403);
  expect(errnoToStatus('EISDIR')).toBe(400);
  expect(errnoToStatus('EIO')).toBe(503);
  expect(errnoToStatus('EWHATEVER')).toBe(500);
});

test('parseSyncFsRequest: GET → read with token + decoded path', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a.txt',
    method: 'GET',
    headers: { get: (n) => (n === 'x-slicc-fs-token' ? 'tok123' : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toEqual({ token: 'tok123', op: 'read', path: '/workspace/a.txt' });
});

test('parseSyncFsRequest: POST → write with body', async () => {
  const body = new TextEncoder().encode('hello');
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/b.txt',
    method: 'POST',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
  expect(parsed?.op).toBe('write');
  expect(new TextDecoder().decode(parsed?.body as Uint8Array)).toBe('hello');
});

test('parseSyncFsRequest: non-route → null', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/preview/workspace/a.txt',
    method: 'GET',
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toBeNull();
});

test('parseSyncFsRequest decodes per-segment (round-trips %20, #)', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a%20b%23c.txt',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed?.path).toBe('/workspace/a b#c.txt');
});

test('parseSyncFsRequest: GET ?op=stat → stat op (phase-2 metadata wire)', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a.txt?op=stat',
    method: 'GET',
    headers: { get: (n) => (n === 'x-slicc-fs-token' ? 'tok' : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toEqual({ token: 'tok', op: 'stat', path: '/workspace/a.txt' });
});

test('parseSyncFsRequest: GET ?op=lstat → lstat op', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/link?op=lstat',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toEqual({ token: 'tok', op: 'lstat', path: '/workspace/link' });
});

test('parseSyncFsRequest: GET ?op=readdir → readdir op', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace?op=readdir',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed?.op).toBe('readdir');
  expect(parsed?.path).toBe('/workspace');
});

test('parseSyncFsRequest: GET ?op=exists → exists op', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/gone.txt?op=exists',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed?.op).toBe('exists');
});

test.each(['mkdir', 'rm'])(
  'parseSyncFsRequest: POST ?op=%s → mutating op with no body',
  async (op) => {
    const parsed = await parseSyncFsRequest({
      url: `https://www.sliccy.ai/__slicc/fs-sync/workspace/d?op=${op}`,
      method: 'POST',
      headers: { get: () => 'tok' },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(parsed).toEqual({ token: 'tok', op, path: '/workspace/d' });
  }
);

test('parseSyncFsRequest: exec route → exec channel request off the JSON envelope', async () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ command: 'echo hi', stdin: 'in', timeoutMs: 900 })
  );
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/exec-sync',
    method: 'POST',
    headers: { get: (n) => (n === 'x-slicc-fs-token' ? 'tok' : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
  expect(parsed).toEqual({
    token: 'tok',
    channel: 'exec',
    command: 'echo hi',
    stdin: 'in',
    timeoutMs: 900,
  });
});

test('parseSyncFsRequest: exec route rejects a GET (POST-only envelope)', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/exec-sync',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toBeNull();
});

test.each([
  ['not JSON', 'not json at all'],
  ['no command', '{"stdin":"x"}'],
  ['command of the wrong type', '{"command":42}'],
  ['argv with a non-string member', '{"command":[1,2]}'],
])('parseSyncFsRequest: exec route fails closed on a malformed envelope (%s)', async (_l, raw) => {
  const body = new TextEncoder().encode(raw);
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/exec-sync',
    method: 'POST',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
  expect(parsed).toBeNull();
});

test('an exec request waits on the exec budget, not the fs one', async () => {
  vi.useFakeTimers();
  try {
    const ch = respondingChannel(() => null);
    const pending = handleSyncFsRequest([ch], {
      token: 't',
      channel: 'exec',
      command: 'build',
      timeoutMs: 300_000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(250_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get('x-slicc-fs-errno')).toBe('EIO');
  } finally {
    vi.useRealTimers();
  }
});

test('a caller budget above the ceiling is clamped, not honored verbatim', async () => {
  vi.useFakeTimers();
  try {
    const ch = respondingChannel(() => null);
    const pending = handleSyncFsRequest([ch], {
      token: 't',
      channel: 'exec',
      command: 'forever',
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    await vi.advanceTimersByTimeAsync(
      SYNC_EXEC_MAX_TIMEOUT_MS + SYNC_EXEC_RESPONSE_MARGIN_MS + 1_000
    );
    expect((await pending).status).toBe(503);
  } finally {
    vi.useRealTimers();
  }
});

test("the SW waits past the command budget so the responder's ETIMEDOUT wins", async () => {
  vi.useFakeTimers();
  try {
    const budgetMs = 10_000;
    const ch = deferredChannel(budgetMs + 500, {
      ok: false,
      errno: 'ETIMEDOUT',
      message: 'sync-exec: timed out',
    });
    const pending = handleSyncFsRequest([ch], {
      token: 't',
      channel: 'exec',
      command: 'sleep 99',
      timeoutMs: budgetMs,
    });
    await vi.advanceTimersByTimeAsync(budgetMs + 1_000);
    const res = await pending;
    expect(res.headers.get('x-slicc-fs-errno')).toBe('ETIMEDOUT');
  } finally {
    vi.useRealTimers();
  }
});

test('parseSyncFsRequest: GET with an UNKNOWN ?op= falls back to read (typo → bytes route)', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a.txt?op=lolwat',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed?.op).toBe('read');
});

test('parseSyncFsRequest: POST + ?op=stat → write wins (POST is authoritative)', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a.txt?op=stat',
    method: 'POST',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed?.op).toBe('write');
});

test('parseSyncFsRequest: malformed percent-encoding in a valid route → null (fail closed)', async () => {
  const parsed = await parseSyncFsRequest({
    url: 'https://www.sliccy.ai/__slicc/fs-sync/workspace/a%ZZb.txt',
    method: 'GET',
    headers: { get: () => 'tok' },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  expect(parsed).toBeNull();
});

function coldStartChannel(dropFirst: number, onPost: () => void): SyncFsSwChannelLike {
  let posts = 0;
  const listeners = new Set<(e: MessageEvent) => void>();
  const emit = (data: unknown): void => {
    for (const l of [...listeners]) l({ data } as MessageEvent);
  };
  return {
    postMessage: (data: unknown) => {
      const req = data as Record<string, unknown>;
      if (req?.type !== 'sync-fs-req') return;
      posts += 1;
      onPost();
      if (posts <= dropFirst) return;
      queueMicrotask(() => emit({ type: 'sync-fs-ack', id: req.id }));
      queueMicrotask(() =>
        emit({
          type: 'sync-fs-res',
          id: req.id,
          ok: true,
          kind: 'bytes',
          bytes: new TextEncoder().encode('late'),
        })
      );
    },
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
  };
}

test('cold-start: re-posts until the responder attaches, then resolves (recovery)', async () => {
  let posts = 0;
  const ch = coldStartChannel(2, () => {
    posts += 1;
  });
  const res = await handleSyncFsRequest(
    [ch],
    { token: 't', op: 'read', path: '/x' },
    { timeoutMs: 2000, retryIntervalMs: 5 }
  );
  expect(res.status).toBe(200);
  expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe('late');
  expect(posts).toBeGreaterThanOrEqual(3);
});

test('ack halts the re-post loop — no further posts after ack even if the res is delayed', async () => {
  let posts = 0;
  const listeners = new Set<(e: MessageEvent) => void>();
  const emit = (data: unknown): void => {
    for (const l of [...listeners]) l({ data } as MessageEvent);
  };
  const ch: SyncFsSwChannelLike = {
    postMessage: (data: unknown) => {
      const req = data as Record<string, unknown>;
      if (req?.type !== 'sync-fs-req') return;
      posts += 1;
      queueMicrotask(() => emit({ type: 'sync-fs-ack', id: req.id }));

      setTimeout(
        () =>
          emit({
            type: 'sync-fs-res',
            id: req.id,
            ok: true,
            kind: 'bytes',
            bytes: new Uint8Array(0),
          }),
        60
      );
    },
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
  };
  const res = await handleSyncFsRequest(
    [ch],
    { token: 't', op: 'read', path: '/x' },
    { timeoutMs: 2000, retryIntervalMs: 10 }
  );
  expect(res.status).toBe(200);
  expect(posts).toBe(1);
});

test('fan-out: request is posted to every channel; only the owning responder answers', async () => {
  let silentPosts = 0;
  const silent: SyncFsSwChannelLike = {
    postMessage: (data: unknown) => {
      if ((data as Record<string, unknown>)?.type === 'sync-fs-req') silentPosts += 1;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const owner = respondingChannel(() => ({
    ok: true,
    kind: 'bytes',
    bytes: new TextEncoder().encode('owned'),
  }));
  let ownerPosts = 0;
  const ownerPost = owner.postMessage;
  owner.postMessage = (data: unknown): void => {
    if ((data as Record<string, unknown>)?.type === 'sync-fs-req') ownerPosts += 1;
    ownerPost(data);
  };

  const res = await handleSyncFsRequest([silent, owner], {
    token: 't',
    op: 'read',
    path: '/workspace/a.txt',
  });

  expect(res.status).toBe(200);
  expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()))).toBe('owned');
  expect(silentPosts).toBe(1);
  expect(ownerPosts).toBe(1);
});

function deadChannel(onPost?: () => void): SyncFsSwChannelLike {
  const listeners = new Set<(e: MessageEvent) => void>();
  return {
    postMessage: () => onPost?.(),
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.add(l),
    removeEventListener: (_t: string, l: (e: MessageEvent) => void) => listeners.delete(l),
  } as unknown as SyncFsSwChannelLike;
}

test('an unacked request fails closed on the no-responder window, not the full exec budget', async () => {
  vi.useFakeTimers();
  try {
    const ch = deadChannel();
    const pending = handleSyncFsRequest([ch], {
      token: 't',
      channel: 'exec',
      command: 'build',
      timeoutMs: 600_000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get('x-slicc-fs-errno')).toBe('EIO');
    expect(await res.text()).toBe('sync-fs bridge: no responder');
  } finally {
    vi.useRealTimers();
  }
});

test('an acked-but-slow responder still gets the whole budget', async () => {
  vi.useFakeTimers();
  try {
    const ch = respondingChannel(() => null);
    const pending = handleSyncFsRequest([ch], {
      token: 't',
      channel: 'exec',
      command: 'build',
      timeoutMs: 300_000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(250_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('sync-fs bridge timeout');
  } finally {
    vi.useRealTimers();
  }
});

test('the no-responder window never outlives a shorter overall budget', async () => {
  vi.useFakeTimers();
  try {
    const pending = handleSyncFsRequest(
      [deadChannel()],
      { token: 't', op: 'read', path: '/tmp/x' },
      { timeoutMs: 3_000 }
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    expect(res.status).toBe(503);
  } finally {
    vi.useRealTimers();
  }
});

test('the no-responder response is tagged for SW re-arm; a plain timeout is not', async () => {
  vi.useFakeTimers();
  try {
    const unacked = handleSyncFsRequest([deadChannel()], { token: 't', op: 'read', path: '/x' });
    await vi.advanceTimersByTimeAsync(11_000);
    const noResponder = await unacked;
    expect(noResponder.headers.get('x-slicc-fs-no-responder')).toBe('1');
    expect(await noResponder.text()).toBe('sync-fs bridge: no responder');

    const acked = handleSyncFsRequest([respondingChannel(() => null)], {
      token: 't',
      channel: 'exec',
      command: 'build',
      timeoutMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    const timedOut = await acked;
    expect(timedOut.headers.get('x-slicc-fs-no-responder')).toBeNull();
    expect(await timedOut.text()).toBe('sync-fs bridge timeout');
  } finally {
    vi.useRealTimers();
  }
});
