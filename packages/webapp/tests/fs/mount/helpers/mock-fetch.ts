import { vi, type MockedFunction } from 'vitest';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
}

export interface MockFetchHandle {
  fetch: MockedFunction<typeof fetch>;
  /** All calls made, oldest first. */
  calls: CapturedRequest[];
  /** Restore the original global fetch. */
  restore(): void;
  /** Enqueue the next response (or a factory that produces one). */
  enqueue(response: Response | (() => Response | Promise<Response>)): void;
}

/**
 * Install a queue-based mock for `globalThis.fetch`. Each call dequeues the
 * next response. Tests should `enqueue(...)` each expected response in
 * order; an unexpected call (queue empty) throws so test bugs surface as
 * test failures, not silent fallthroughs.
 *
 * Captures URL, method, headers (lowercased keys), and body bytes per call
 * so tests can assert on the signed-request shape (Authorization header,
 * X-Amz-Date, X-Amz-Content-Sha256, body bytes preserved through SigV4).
 */
export function installFetchMock(): MockFetchHandle {
  const original = globalThis.fetch;
  const queue: Array<Response | (() => Response | Promise<Response>)> = [];
  const calls: CapturedRequest[] = [];

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: Uint8Array | undefined;
    if (req.body) {
      const arrayBuf = await req.arrayBuffer();
      body = new Uint8Array(arrayBuf);
    }
    calls.push({
      url: req.url,
      method: req.method,
      headers,
      body,
    });

    if (queue.length === 0) {
      throw new Error(`mock-fetch: unexpected call to ${req.method} ${req.url}`);
    }
    const next = queue.shift()!;
    return typeof next === 'function' ? await next() : next;
  }) as MockedFunction<typeof fetch>;

  globalThis.fetch = mock as unknown as typeof fetch;

  return {
    fetch: mock,
    calls,
    enqueue(response) {
      queue.push(response);
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
