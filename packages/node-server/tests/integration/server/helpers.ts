import { expect } from 'vitest';
import WebSocket, { type RawData } from 'ws';

export type JsonObject = Record<string, unknown>;

const DEFAULT_BASE_URL = 'http://localhost:5710';

export const BASE_URL = (process.env['SLICC_TEST_SERVER_URL'] ?? DEFAULT_BASE_URL).replace(/\/$/, '');

export function serverUrl(path: string): string {
  return new URL(path, `${BASE_URL}/`).toString();
}

export function websocketUrl(path: string): string {
  const url = new URL(path, `${BASE_URL}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function fetchFromServer(path: string, init?: RequestInit): Promise<Response> {
  return fetch(serverUrl(path), init);
}

export function extractAssetPath(html: string, kind: 'script' | 'stylesheet'): string {
  const pattern =
    kind === 'script'
      ? /<script[^>]+src="([^"]+\.(?:m?js))"/i
      : /<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/i;
  const match = html.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not find ${kind} asset in HTML response`);
  }
  return match[1];
}

function decodeRawData(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export async function openWebSocket(
  path: string
): Promise<{ socket: WebSocket; nextMessage: () => Promise<JsonObject> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl(path));
    const queue: JsonObject[] = [];
    const waiters: Array<(message: JsonObject) => void> = [];

    socket.on('message', (data) => {
      const message = JSON.parse(decodeRawData(data)) as JsonObject;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        queue.push(message);
      }
    });

    const nextMessage = (): Promise<JsonObject> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise((res, rej) => {
        const timeout = setTimeout(() => rej(new Error('Timed out waiting for WebSocket message')), 10_000);
        waiters.push((message) => {
          clearTimeout(timeout);
          res(message);
        });
      });
    };

    socket.once('open', () => resolve({ socket, nextMessage }));
    socket.once('error', reject);
  });
}

export async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

export function expectStringOrNull(value: unknown): void {
  expect(value === null || typeof value === 'string').toBe(true);
}
