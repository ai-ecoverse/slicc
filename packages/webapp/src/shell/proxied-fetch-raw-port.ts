import {
  base64ToUint8,
  parseRawFetchProbeReply,
  RAW_FETCH_PORT_CHUNK_BYTES,
  RAW_FETCH_PORT_WINDOW,
  type RawFetchErrorCode,
  type RawFetchProbeReply,
  type RawPortRequestMsg,
  type RawPortResponseMsg,
  uint8ToBase64,
} from '@slicc/shared-ts';
import {
  RawFetchError,
  type RawFetchInit,
  type RawFetchResponse,
} from './proxied-fetch-raw-types.js';

export interface RawFetchPort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

function* portChunks(bytes: Uint8Array): Generator<Uint8Array> {
  for (let off = 0; off < bytes.byteLength; off += RAW_FETCH_PORT_CHUNK_BYTES) {
    yield bytes.subarray(off, off + RAW_FETCH_PORT_CHUNK_BYTES);
  }
}

function knownLength(body: RawFetchInit['body'], hint: number | undefined): number | undefined {
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return hint;
}

class PortSession {
  private uploadCredits = 0;
  private creditWaiter: (() => void) | null = null;
  private queue: Uint8Array[] = [];
  private ended = false;
  private failure: RawFetchError | null = null;
  private wake: (() => void) | null = null;

  private cancelUpload: (() => void) | null = null;
  settled = false;

  constructor(
    private readonly port: RawFetchPort,
    private readonly onHead: (
      msg: Extract<RawPortResponseMsg, { type: 'raw-response-head' }>
    ) => void,
    private readonly onFail: (err: RawFetchError) => void
  ) {}

  handle(raw: unknown): void {
    const msg = raw as RawPortResponseMsg;
    if (msg.type === 'raw-body-credit') {
      this.uploadCredits += msg.chunks;
      this.notifyCredit();
    } else if (msg.type === 'raw-response-head') {
      this.onHead(msg);
    } else if (msg.type === 'raw-response-chunk') {
      this.queue.push(base64ToUint8(msg.dataBase64));
      this.notify();
    } else if (msg.type === 'raw-response-end') {
      this.ended = true;
      this.notify();
    } else if (msg.type === 'raw-response-error') {
      this.fail(new RawFetchError(msg.code as RawFetchErrorCode, msg.status, msg.error));
    }
  }

  fail(err: RawFetchError): void {
    if (this.failure || this.ended) return;
    this.failure = err;
    this.cancelUpload?.();
    this.onFail(err);
    this.notify();
    this.notifyCredit();
  }

  async upload(body: NonNullable<RawFetchInit['body']>): Promise<void> {
    if (body instanceof Uint8Array) {
      for (const chunk of portChunks(body)) if (!(await this.send(chunk))) return;
    } else {
      const reader = (body instanceof Blob ? body.stream() : body).getReader();
      this.cancelUpload = () => void reader.cancel().catch(() => undefined);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.failure) break;
          for (const chunk of portChunks(value)) if (!(await this.send(chunk))) return;
        }
      } finally {
        this.cancelUpload = null;
      }
    }
    if (!this.failure) this.post({ type: 'raw-body-end' });
  }

  private async send(chunk: Uint8Array): Promise<boolean> {
    while (this.uploadCredits <= 0 && !this.failure) {
      await new Promise<void>((resolve) => {
        this.creditWaiter = resolve;
      });
    }
    if (this.failure) return false;
    this.uploadCredits -= 1;
    this.post({ type: 'raw-body-chunk', dataBase64: uint8ToBase64(chunk) });
    return true;
  }

  async next(): Promise<Uint8Array | null> {
    while (this.queue.length === 0 && !this.ended && !this.failure) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    const chunk = this.queue.shift();
    if (chunk) {
      this.post({ type: 'raw-credit', chunks: 1 });
      return chunk;
    }
    if (this.failure) throw this.failure;
    return null;
  }

  post(msg: RawPortRequestMsg): void {
    this.port.postMessage(msg);
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private notifyCredit(): void {
    const w = this.creditWaiter;
    this.creditWaiter = null;
    w?.();
  }
}

export function rawFetchViaPort(
  connect: () => RawFetchPort,
  url: string,
  init: RawFetchInit & { bodyLength?: number } = {}
): Promise<RawFetchResponse> {
  const method = init.method ?? 'GET';
  const signal = init.signal;
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  const port = connect();
  return new Promise<RawFetchResponse>((resolve, reject) => {
    let headSeen = false;
    const session = new PortSession(
      port,
      (msg) => {
        headSeen = true;
        const body = msg.hasBody ? responseStream(session, () => finish()) : null;
        if (!body) finish();
        resolve({ ...msg.head, body });
      },
      (err) => {
        if (!headSeen) reject(err);
        finish();
      }
    );
    const finish = () => {
      if (session.settled) return;
      session.settled = true;
      signal?.removeEventListener('abort', onAbort);
      port.disconnect();
    };
    const onAbort = () => {
      if (!headSeen) reject(new DOMException('The operation was aborted.', 'AbortError'));
      session.fail(new RawFetchError('upstream', 499, 'raw fetch: aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    port.onMessage.addListener((raw) => session.handle(raw));
    port.onDisconnect.addListener(() => {
      session.settled = true;
      session.fail(new RawFetchError('bridge', 502, 'raw fetch: extension Port disconnected'));
    });
    session.post({
      type: 'raw-request',
      head: { url, method, headers: init.headers ?? [] },
      hasBody: init.body !== undefined,
      bodyLength: knownLength(init.body, init.bodyLength),
      credits: RAW_FETCH_PORT_WINDOW,
    });
    if (init.body !== undefined) {
      session.upload(init.body).catch((err) => {
        session.fail(
          new RawFetchError('bridge', 502, err instanceof Error ? err.message : String(err))
        );
      });
    }
  });
}

function responseStream(session: PortSession, onDone: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunk = await session.next();
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
        onDone();
      },
      cancel() {
        session.fail(new RawFetchError('upstream', 499, 'raw fetch: cancelled'));
      },
    },
    { highWaterMark: 0 }
  );
}

export function probeRawPort(
  connect: () => RawFetchPort,
  timeoutMs: number
): Promise<RawFetchProbeReply | null | 'silent'> {
  return new Promise((resolve) => {
    let settled = false;
    let port: RawFetchPort | null = null;
    const settle = (answer: RawFetchProbeReply | null | 'silent') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port?.disconnect();
      resolve(answer);
    };
    const timer = setTimeout(() => settle('silent'), timeoutMs);
    try {
      port = connect();
    } catch {
      settle(null);
      return;
    }
    port.onMessage.addListener((raw) => {
      const msg = raw as RawPortResponseMsg;
      if (msg.type === 'raw-probe-reply') settle(parseRawFetchProbeReply(msg.reply));
      else if (msg.type === 'raw-response-error') settle(null);
    });
    port.onDisconnect.addListener(() => settle('silent'));
    port.postMessage({ type: 'raw-probe' } satisfies RawPortRequestMsg);
  });
}
