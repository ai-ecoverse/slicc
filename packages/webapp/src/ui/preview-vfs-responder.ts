import type { LocalVfsClient } from '../kernel/local-vfs-client.js';

export interface PreviewVfsReadRequest {
  type: 'preview-vfs-read';

  id: string;
  path: string;

  asText: boolean;

  start?: number;
  end?: number;
}

export type PreviewVfsResponse =
  | { type: 'preview-vfs-ack'; id: string }
  | { type: 'preview-vfs-start'; id: string }
  | { type: 'preview-vfs-response'; id: string; content: string | Uint8Array; size?: number }
  | { type: 'preview-vfs-response'; id: string; error: string };

export interface PreviewVfsChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface PreviewVfsResponderOptions {
  getReader: () => LocalVfsClient;

  channel: PreviewVfsChannelLike;

  logger?: { error(msg: string, meta?: PreviewVfsReadFailure): void };
}

export interface PreviewVfsReadFailure {
  path: string;
  error: string;
}

export interface PreviewVfsResponderHandle {
  dispose(): void;
}

export function installPreviewVfsResponder(
  opts: PreviewVfsResponderOptions
): PreviewVfsResponderHandle {
  const { channel, getReader, logger } = opts;

  async function respond(
    id: string,
    path: string,
    asText: boolean,
    start?: number,
    end?: number
  ): Promise<void> {
    try {
      const reader = getReader();

      const stats = await reader.stat(path);
      if (stats.type === 'directory') {
        channel.postMessage({
          type: 'preview-vfs-response',
          id,
          error: `EISDIR: is a directory '${path}'`,
        } satisfies PreviewVfsResponse);
        return;
      }
      if (!asText && Number.isInteger(start)) {
        const content = await readBinaryWindow(reader, path, start as number, end, stats.size);
        channel.postMessage({
          type: 'preview-vfs-response',
          id,
          content,
          size: stats.size,
        } satisfies PreviewVfsResponse);
        return;
      }
      const encoding = asText ? 'utf-8' : 'binary';
      const content = await reader.readFile(path, { encoding });
      channel.postMessage({
        type: 'preview-vfs-response',
        id,
        content,
        ...(asText ? {} : { size: stats.size }),
      } satisfies PreviewVfsResponse);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes('ENOENT')) {
        logger?.error('Preview VFS read failed', { path, error: errMsg });
      }
      channel.postMessage({
        type: 'preview-vfs-response',
        id,
        error: errMsg,
      } satisfies PreviewVfsResponse);
    }
  }

  let queue: Promise<void> = Promise.resolve();

  const listener = (event: MessageEvent): void => {
    const data = event.data as PreviewVfsReadRequest | undefined;
    if (data?.type !== 'preview-vfs-read') return;
    const { id, path, asText, start, end } = data;

    channel.postMessage({ type: 'preview-vfs-ack', id } satisfies PreviewVfsResponse);

    const dequeue = (): Promise<void> => {
      channel.postMessage({ type: 'preview-vfs-start', id } satisfies PreviewVfsResponse);
      return respond(id, path, asText, start, end);
    };
    queue = queue.then(dequeue, dequeue);
  };
  channel.addEventListener('message', listener);
  return {
    dispose: () => channel.removeEventListener('message', listener),
  };
}

async function readBinaryWindow(
  reader: LocalVfsClient,
  path: string,
  start: number,
  end: number | undefined,
  size: number
): Promise<Uint8Array> {
  const to = Math.min(end ?? size, size);
  if (start >= size || start >= to) return new Uint8Array(0);
  if (reader.readFileRange) {
    return reader.readFileRange(path, start, to);
  }
  const whole = await reader.readFile(path, { encoding: 'binary' });
  if (!(whole instanceof Uint8Array)) return new Uint8Array(0);
  return new Uint8Array(whole.subarray(start, Math.min(to, whole.byteLength)));
}
