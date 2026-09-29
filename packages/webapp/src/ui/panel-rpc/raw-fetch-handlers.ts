import type { PanelRpcHandlers, RawFetchRpcFailure } from '../../kernel/panel-rpc.js';
import { RawFetchError, type RawFetchResponse } from '../../shell/proxied-fetch-raw-types.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

class UploadPipe {
  private pending: { chunk: Uint8Array | null; taken: () => void } | null = null;
  private waiter: (() => void) | null = null;
  readonly stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        while (!this.pending) {
          await new Promise<void>((resolve) => {
            this.waiter = resolve;
          });
        }
        const { chunk, taken } = this.pending;
        this.pending = null;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
        taken();
      },
    },
    { highWaterMark: 0 }
  );

  write(chunk: Uint8Array | null): Promise<void> {
    return new Promise((taken) => {
      this.pending = { chunk, taken };
      const w = this.waiter;
      this.waiter = null;
      w?.();
    });
  }
}

interface Session {
  upload: UploadPipe | null;
  response: Promise<RawFetchResponse>;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  abort: AbortController;
  idle: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

function toFailure(err: unknown): RawFetchRpcFailure {
  if (err instanceof RawFetchError) {
    return { ok: false, code: err.code, status: err.status, error: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code: 'bridge', status: 502, error: message };
}

const unknownSession = (): RawFetchRpcFailure => ({
  ok: false,
  code: 'bridge',
  status: 502,
  error: 'raw fetch: unknown or finished session',
});

function close(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.idle);
  session.abort.abort();
  void session.reader?.cancel().catch(() => undefined);
}

function touch(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  clearTimeout(session.idle);
  session.idle = setTimeout(() => close(id), IDLE_TIMEOUT_MS);
  return session;
}

function failureOf(session: Session): Promise<never> {
  return session.response.then(() => new Promise<never>(() => {}));
}

export function buildRawFetchHandlers() {
  return {
    'raw-fetch-probe': async (_payload) => {
      const { getRawFetchCapabilities } = await import('../../shell/proxied-fetch-raw.js');
      return getRawFetchCapabilities();
    },
    'raw-fetch-open': async ({ url, method, headers, hasBody, bodyLength }) => {
      const [{ extensionPortConnector }, { rawFetchViaPort }] = await Promise.all([
        import('../../shell/proxied-fetch-raw.js'),
        import('../../shell/proxied-fetch-raw-port.js'),
      ]);
      const connect = extensionPortConnector();
      if (!connect) throw new Error('raw fetch: no extension Port in this realm');
      const id = crypto.randomUUID();
      const upload = hasBody ? new UploadPipe() : null;
      const abort = new AbortController();
      const response = rawFetchViaPort(connect, url, {
        method,
        headers,
        body: upload?.stream,
        bodyLength,
        signal: abort.signal,
      });
      response.catch(() => undefined);
      sessions.set(id, {
        upload,
        response,
        reader: null,
        abort,
        idle: setTimeout(() => close(id), IDLE_TIMEOUT_MS),
      });
      return { id };
    },
    'raw-fetch-write': async ({ id, chunk }) => {
      const session = touch(id);
      if (!session?.upload) return unknownSession();
      try {
        await Promise.race([session.upload.write(chunk), failureOf(session)]);
        return { ok: true as const };
      } catch (err) {
        close(id);
        return toFailure(err);
      }
    },
    'raw-fetch-head': async ({ id }) => {
      const session = touch(id);
      if (!session) return unknownSession();
      try {
        const { body, ...head } = await session.response;
        session.reader = body?.getReader() ?? null;
        if (!body) close(id);
        return { ok: true as const, head, hasBody: body !== null };
      } catch (err) {
        close(id);
        return toFailure(err);
      }
    },
    'raw-fetch-read': async ({ id }) => {
      const session = touch(id);
      if (!session?.reader) return unknownSession();
      try {
        const { done, value } = await session.reader.read();
        if (done) close(id);
        return { ok: true as const, chunk: done ? null : value };
      } catch (err) {
        close(id);
        return toFailure(err);
      }
    },
    'raw-fetch-cancel': async ({ id }) => {
      close(id);
      return { ok: true as const };
    },
  } satisfies Partial<PanelRpcHandlers>;
}
