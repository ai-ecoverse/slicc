import type { FsWatcher } from '../fs/fs-watcher.js';
import { FsError } from '../fs/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  VfsDirEntryEnvelope,
  VfsErrorEnvelope,
  VfsFlushRequestMsg,
  VfsFlushResultMsg,
  VfsListMountPointsRequestMsg,
  VfsListMountPointsResultMsg,
  VfsMkdirRequestMsg,
  VfsMkdirResultMsg,
  VfsReadDirRequestMsg,
  VfsReadDirResultMsg,
  VfsReadFileRequestMsg,
  VfsReadFileResultMsg,
  VfsReadRequestMsg,
  VfsRmRequestMsg,
  VfsRmResultMsg,
  VfsStatRequestMsg,
  VfsStatResultMsg,
  VfsStatsEnvelope,
  VfsUnwatchRequestMsg,
  VfsWatchControlMsg,
  VfsWatchEventMsg,
  VfsWatchRequestMsg,
  VfsWatchResultMsg,
  VfsWriteFileRequestMsg,
  VfsWriteFileResultMsg,
  VfsWriteRequestMsg,
} from './messages.js';
import type { KernelTransport } from './types.js';
import type { WritableVfsBackend } from './writable-vfs-client.js';

export interface VfsRpcHostOptions {
  transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;

  client: LocalVfsClient;

  writableClient?: WritableVfsBackend;

  getWatcher?: () => FsWatcher | null;

  logger?: {
    warn(msg: string, ...rest: unknown[]): void;
    debug?(msg: string, ...rest: unknown[]): void;
  };
}

export interface VfsRpcHostHandle {
  stop: () => void;
}

export function startVfsRpcHost(options: VfsRpcHostOptions): VfsRpcHostHandle {
  const host = new VfsRpcHost(options);
  host.start();
  return { stop: () => host.dispose() };
}

class VfsRpcHost {
  private readonly transport: KernelTransport<ExtensionMessage, OffscreenToPanelMessage>;
  private readonly client: LocalVfsClient;
  private readonly writableClient: WritableVfsBackend | null;
  private readonly getWatcher: (() => FsWatcher | null) | null;
  private readonly log: NonNullable<VfsRpcHostOptions['logger']>;
  private unsubscribe: (() => void) | null = null;

  private readonly watches = new Map<string, Array<() => void>>();

  constructor(options: VfsRpcHostOptions) {
    this.transport = options.transport;
    this.client = options.client;
    this.writableClient = options.writableClient ?? null;
    this.getWatcher = options.getWatcher ?? null;
    this.log = options.logger ?? console;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.onMessage((envelope) => {
      if (!isExtensionEnvelope(envelope)) return;
      if (envelope.source !== 'panel') return;
      const payload = envelope.payload as PanelToOffscreenMessage;
      if (isVfsReadRequest(payload)) {
        void this.handleRequest(payload).catch((err) => {
          this.log.warn('[vfs-rpc-host] handler unexpectedly threw', err);
        });
        return;
      }
      if (isVfsWriteRequest(payload)) {
        void this.handleWriteRequest(payload).catch((err) => {
          this.log.warn('[vfs-rpc-host] write handler unexpectedly threw', err);
        });
        return;
      }
      if (isVfsWatchControl(payload)) {
        this.handleWatchControl(payload);
        return;
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, unsubs] of this.watches) for (const off of unsubs) off();
    this.watches.clear();
  }

  private handleWatchControl(req: VfsWatchControlMsg): void {
    if (req.type === 'vfs-watch') this.handleWatch(req);
    else this.handleUnwatch(req);
  }

  private handleWatch(req: VfsWatchRequestMsg): void {
    this.dropWatch(req.subscriptionId);
    const watcher = this.getWatcher?.() ?? null;
    if (!watcher) {
      this.sendWatchAck({
        type: 'vfs-watch-result',
        subscriptionId: req.subscriptionId,
        ok: false,
        error: { code: 'ENOSYS', message: 'vfs-rpc-host has no watcher wired' },
      });
      return;
    }
    const unsubs = req.basePaths.map((basePath) =>
      watcher.watch(
        basePath,
        () => true,
        (events) => {
          if (!this.watches.has(req.subscriptionId)) return;
          const msg: VfsWatchEventMsg = {
            type: 'vfs-watch-event',
            subscriptionId: req.subscriptionId,
            events: events.map((e) => ({
              type: e.type,
              path: e.path,
              ...(e.entryType ? { entryType: e.entryType } : {}),
            })),
          };
          this.transport.send(msg);
        }
      )
    );
    this.watches.set(req.subscriptionId, unsubs);
    this.sendWatchAck({
      type: 'vfs-watch-result',
      subscriptionId: req.subscriptionId,
      ok: true,
    });
  }

  private handleUnwatch(req: VfsUnwatchRequestMsg): void {
    this.dropWatch(req.subscriptionId);
  }

  private dropWatch(subscriptionId: string): void {
    const unsubs = this.watches.get(subscriptionId);
    if (!unsubs) return;
    this.watches.delete(subscriptionId);
    for (const off of unsubs) off();
  }

  private sendWatchAck(msg: VfsWatchResultMsg): void {
    this.transport.send(msg);
  }

  private async handleRequest(req: VfsReadRequestMsg): Promise<void> {
    switch (req.type) {
      case 'vfs-read-dir':
        return this.handleReadDir(req);
      case 'vfs-read-file':
        return this.handleReadFile(req);
      case 'vfs-stat':
        return this.handleStat(req);
    }
  }

  private async handleReadDir(req: VfsReadDirRequestMsg): Promise<void> {
    try {
      const entries =
        req.includeStats === true
          ? await this.client.readDir(req.path, { includeStats: true })
          : await this.client.readDir(req.path);

      const wireEntries = entries as VfsDirEntryEnvelope[];
      const response: VfsReadDirResultMsg = {
        type: 'vfs-read-dir-result',
        requestId: req.requestId,
        ok: true,
        entries: wireEntries,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitError('vfs-read-dir-result', req.requestId, err, req.path);
    }
  }

  private async handleReadFile(req: VfsReadFileRequestMsg): Promise<void> {
    const encoding = req.encoding ?? 'utf-8';
    try {
      if (encoding === 'binary' && Number.isInteger(req.start)) {
        const data = await this.readFileWindow(req.path, req.start as number, req.end);
        this.sendBinaryReadResult(req.requestId, req.path, data);
        return;
      }
      const data = await this.client.readFile(req.path, { encoding });
      if (encoding === 'binary') {
        this.sendBinaryReadResult(req.requestId, req.path, data);
      } else {
        if (typeof data !== 'string') {
          this.emitError(
            'vfs-read-file-result',
            req.requestId,
            new FsError('EIO', 'readFile(utf-8) did not return string'),
            req.path
          );
          return;
        }
        const response: VfsReadFileResultMsg = {
          type: 'vfs-read-file-result',
          requestId: req.requestId,
          ok: true,
          encoding: 'utf-8',
          data,
        };
        this.transport.send(response);
      }
    } catch (err) {
      this.emitError('vfs-read-file-result', req.requestId, err, req.path);
    }
  }

  private async readFileWindow(path: string, start: number, end?: number): Promise<Uint8Array> {
    const to = end ?? (await this.client.stat(path)).size;
    if (this.client.readFileRange) {
      return this.client.readFileRange(path, start, to);
    }
    const whole = await this.client.readFile(path, { encoding: 'binary' });
    if (!(whole instanceof Uint8Array)) {
      throw new FsError('EIO', 'readFile(binary) did not return Uint8Array', path);
    }
    return new Uint8Array(whole.subarray(start, Math.min(to, whole.byteLength)));
  }

  private sendBinaryReadResult(requestId: string, path: string, data: string | Uint8Array): void {
    if (!(data instanceof Uint8Array)) {
      this.emitError(
        'vfs-read-file-result',
        requestId,
        new FsError('EIO', 'readFile(binary) did not return Uint8Array'),
        path
      );
      return;
    }
    const response: VfsReadFileResultMsg = {
      type: 'vfs-read-file-result',
      requestId,
      ok: true,
      encoding: 'binary',
      data,
    };

    const buf = data.buffer;
    const transfer =
      typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer
        ? [buf as Transferable]
        : undefined;
    this.transport.send(response, transfer);
  }

  private async handleStat(req: VfsStatRequestMsg): Promise<void> {
    try {
      const stats = await this.client.stat(req.path);

      const wireStats = stats as VfsStatsEnvelope;
      const response: VfsStatResultMsg = {
        type: 'vfs-stat-result',
        requestId: req.requestId,
        ok: true,
        stats: wireStats,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitError('vfs-stat-result', req.requestId, err, req.path);
    }
  }

  private async handleWriteRequest(req: VfsWriteRequestMsg): Promise<void> {
    if (!this.writableClient) {
      this.emitWriteError(
        writeResultTypeFor(req.type),
        req.requestId,
        new FsError('EACCES', 'vfs-rpc-host has no writable backend wired'),
        writeRequestPath(req)
      );
      return;
    }
    switch (req.type) {
      case 'vfs-write-file':
        return this.handleWriteFile(req, this.writableClient);
      case 'vfs-mkdir':
        return this.handleMkdir(req, this.writableClient);
      case 'vfs-rm':
        return this.handleRm(req, this.writableClient);
      case 'vfs-flush':
        return this.handleFlush(req, this.writableClient);
      case 'vfs-list-mount-points':
        return this.handleListMountPoints(req, this.writableClient);
    }
  }

  private async handleWriteFile(
    req: VfsWriteFileRequestMsg,
    backend: WritableVfsBackend
  ): Promise<void> {
    try {
      if (req.encoding === 'binary') {
        if (!(req.data instanceof Uint8Array)) {
          this.emitWriteError(
            'vfs-write-file-result',
            req.requestId,
            new FsError('EIO', 'vfs-write-file(binary) data is not Uint8Array'),
            req.path
          );
          return;
        }
      } else if (typeof req.data !== 'string') {
        this.emitWriteError(
          'vfs-write-file-result',
          req.requestId,
          new FsError('EIO', 'vfs-write-file(utf-8) data is not string'),
          req.path
        );
        return;
      }
      const opts = req.recursive === undefined ? undefined : { recursive: req.recursive };
      await backend.writeFile(req.path, req.data, opts);
      const response: VfsWriteFileResultMsg = {
        type: 'vfs-write-file-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-write-file-result', req.requestId, err, req.path);
    }
  }

  private async handleMkdir(req: VfsMkdirRequestMsg, backend: WritableVfsBackend): Promise<void> {
    try {
      const opts = req.recursive === undefined ? undefined : { recursive: req.recursive };
      await backend.mkdir(req.path, opts);
      const response: VfsMkdirResultMsg = {
        type: 'vfs-mkdir-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-mkdir-result', req.requestId, err, req.path);
    }
  }

  private async handleRm(req: VfsRmRequestMsg, backend: WritableVfsBackend): Promise<void> {
    try {
      const opts = req.recursive === undefined ? undefined : { recursive: req.recursive };
      await backend.rm(req.path, opts);
      const response: VfsRmResultMsg = {
        type: 'vfs-rm-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-rm-result', req.requestId, err, req.path);
    }
  }

  private async handleFlush(req: VfsFlushRequestMsg, backend: WritableVfsBackend): Promise<void> {
    try {
      await backend.flush();
      const response: VfsFlushResultMsg = {
        type: 'vfs-flush-result',
        requestId: req.requestId,
        ok: true,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-flush-result', req.requestId, err, '');
    }
  }

  private async handleListMountPoints(
    req: VfsListMountPointsRequestMsg,
    backend: WritableVfsBackend
  ): Promise<void> {
    if (!backend.listMountPoints) {
      this.emitWriteError(
        'vfs-list-mount-points-result',
        req.requestId,
        new FsError('EACCES', 'vfs-rpc-host has no mount-aware backend wired'),
        ''
      );
      return;
    }
    try {
      const mountPoints = await backend.listMountPoints();
      const response: VfsListMountPointsResultMsg = {
        type: 'vfs-list-mount-points-result',
        requestId: req.requestId,
        ok: true,
        mountPoints,
      };
      this.transport.send(response);
    } catch (err) {
      this.emitWriteError('vfs-list-mount-points-result', req.requestId, err, '');
    }
  }

  private emitError(
    type: VfsReadDirResultMsg['type'] | VfsReadFileResultMsg['type'] | VfsStatResultMsg['type'],
    requestId: string,
    err: unknown,
    path: string
  ): void {
    const error = toErrorEnvelope(err, path);

    switch (type) {
      case 'vfs-read-dir-result': {
        const msg: VfsReadDirResultMsg = {
          type: 'vfs-read-dir-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-read-file-result': {
        const msg: VfsReadFileResultMsg = {
          type: 'vfs-read-file-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-stat-result': {
        const msg: VfsStatResultMsg = {
          type: 'vfs-stat-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
    }
  }

  private emitWriteError(
    type:
      | VfsWriteFileResultMsg['type']
      | VfsMkdirResultMsg['type']
      | VfsRmResultMsg['type']
      | VfsFlushResultMsg['type']
      | VfsListMountPointsResultMsg['type'],
    requestId: string,
    err: unknown,
    path: string
  ): void {
    const error = toErrorEnvelope(err, path);
    if (path === '' && error.path === '') {
      delete (error as { path?: string }).path;
    }
    switch (type) {
      case 'vfs-write-file-result': {
        const msg: VfsWriteFileResultMsg = {
          type: 'vfs-write-file-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-mkdir-result': {
        const msg: VfsMkdirResultMsg = {
          type: 'vfs-mkdir-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-rm-result': {
        const msg: VfsRmResultMsg = {
          type: 'vfs-rm-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-flush-result': {
        const msg: VfsFlushResultMsg = {
          type: 'vfs-flush-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
      case 'vfs-list-mount-points-result': {
        const msg: VfsListMountPointsResultMsg = {
          type: 'vfs-list-mount-points-result',
          requestId,
          ok: false,
          error,
        };
        this.transport.send(msg);
        return;
      }
    }
  }
}

function isExtensionEnvelope(value: unknown): value is ExtensionMessage {
  return typeof value === 'object' && value !== null && 'source' in value && 'payload' in value;
}

function isVfsReadRequest(payload: unknown): payload is VfsReadRequestMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return t === 'vfs-read-dir' || t === 'vfs-read-file' || t === 'vfs-stat';
}

function isVfsWriteRequest(payload: unknown): payload is VfsWriteRequestMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return (
    t === 'vfs-write-file' ||
    t === 'vfs-mkdir' ||
    t === 'vfs-rm' ||
    t === 'vfs-flush' ||
    t === 'vfs-list-mount-points'
  );
}

function isVfsWatchControl(payload: unknown): payload is VfsWatchControlMsg {
  if (typeof payload !== 'object' || payload === null) return false;
  const t = (payload as { type?: unknown }).type;
  return t === 'vfs-watch' || t === 'vfs-unwatch';
}

function writeResultTypeFor(
  reqType: VfsWriteRequestMsg['type']
):
  | VfsWriteFileResultMsg['type']
  | VfsMkdirResultMsg['type']
  | VfsRmResultMsg['type']
  | VfsFlushResultMsg['type']
  | VfsListMountPointsResultMsg['type'] {
  switch (reqType) {
    case 'vfs-write-file':
      return 'vfs-write-file-result';
    case 'vfs-mkdir':
      return 'vfs-mkdir-result';
    case 'vfs-rm':
      return 'vfs-rm-result';
    case 'vfs-flush':
      return 'vfs-flush-result';
    case 'vfs-list-mount-points':
      return 'vfs-list-mount-points-result';
  }
}

function writeRequestPath(req: VfsWriteRequestMsg): string {
  return req.type === 'vfs-flush' || req.type === 'vfs-list-mount-points' ? '' : req.path;
}

function toErrorEnvelope(err: unknown, path: string): VfsErrorEnvelope {
  if (err instanceof FsError) {
    return {
      code: err.code,
      message: err.message,
      path: err.path ?? path,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'EIO', message, path };
}
