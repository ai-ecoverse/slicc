import type {
  SprinkleEntry,
  SprinkleManagerProxySurface,
  SprinkleOpenOptions,
  SprinkleSendReport,
  SprinkleSendTarget,
} from '../shell/sprinkle-manager-handle.js';

export const SPRINKLE_BRIDGE_CHANNEL = 'slicc-sprinkle-bridge';

export function sprinkleBridgeChannelName(instanceId?: string): string {
  return instanceId ? `${SPRINKLE_BRIDGE_CHANNEL}:${instanceId}` : SPRINKLE_BRIDGE_CHANNEL;
}

export interface SprinkleBridgeRequestMsg {
  type: 'sprinkle-op-request';
  id: string;
  op: 'list' | 'opened' | 'refresh' | 'open' | 'close' | 'send' | 'reload' | 'openNewAutoOpen';
  name?: string;
  data?: unknown;

  target?: SprinkleSendTarget;

  openOptions?: SprinkleOpenOptions;
}

export interface SprinkleBridgeResponseMsg {
  type: 'sprinkle-op-response';
  id: string;
  result?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export function createSprinkleManagerProxyOverChannel(
  options: { timeoutMs?: number; instanceId?: string } = {}
): SprinkleManagerProxySurface {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof BroadcastChannel !== 'function') {
    return makeNullProxy();
  }

  const channelName = sprinkleBridgeChannelName(options.instanceId);
  const channel = new BroadcastChannel(channelName);
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as SprinkleBridgeResponseMsg | undefined;
    if (msg?.type !== 'sprinkle-op-response') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (typeof msg.error === 'string') slot.reject(new Error(msg.error));
    else slot.resolve(msg.result);
  });

  function request(
    op: SprinkleBridgeRequestMsg['op'],
    extras: Partial<SprinkleBridgeRequestMsg> = {}
  ): Promise<unknown> {
    const id = newRequestId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`sprinkle op '${op}' timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const req: SprinkleBridgeRequestMsg = { type: 'sprinkle-op-request', id, op, ...extras };
      channel.postMessage(req);
    });
  }

  let cachedAvailable: SprinkleEntry[] = [];
  let cachedOpened: string[] = [];

  return {
    async refresh(): Promise<void> {
      cachedAvailable = ((await request('list')) as SprinkleEntry[]) ?? [];
      cachedOpened = ((await request('opened')) as string[]) ?? [];
    },
    available(): SprinkleEntry[] {
      return cachedAvailable;
    },
    opened(): string[] {
      return cachedOpened;
    },
    async open(name: string, _zone?: string, openOptions?: SprinkleOpenOptions): Promise<void> {
      await request('open', { name, openOptions });
    },
    close(name: string): void {
      request('close', { name }).catch(() => {});
    },
    async sendToSprinkle(
      name: string,
      data: unknown,
      target?: SprinkleSendTarget
    ): Promise<SprinkleSendReport> {
      const result = (await request('send', { name, data, target })) as SprinkleSendReport | null;
      return result ?? { leader: false, followers: [] };
    },
    async reload(name: string): Promise<void> {
      await request('reload', { name });
    },
    async openNewAutoOpenSprinkles(): Promise<void> {
      await request('openNewAutoOpen');
    },
  };
}

function makeNullProxy(): SprinkleManagerProxySurface {
  const unavailable = (op: string): Error =>
    new Error(`sprinkle bridge unavailable (no BroadcastChannel) — cannot run '${op}'`);
  return {
    refresh: async () => {
      throw unavailable('refresh');
    },
    available: () => [],
    opened: () => [],
    open: async () => {
      throw unavailable('open');
    },
    close: () => {},
    sendToSprinkle: () => {
      throw unavailable('sendToSprinkle');
    },
    reload: async () => {
      throw unavailable('reload');
    },
    openNewAutoOpenSprinkles: async () => {
      throw unavailable('openNewAutoOpenSprinkles');
    },
  };
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sp-${crypto.randomUUID()}`;
  }

  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function installSprinkleManagerHandlerOverChannel(
  manager: SprinkleManagerProxySurface,
  options: { instanceId?: string } = {}
): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(sprinkleBridgeChannelName(options.instanceId));

  const respond = (id: string, result?: unknown, error?: string): void => {
    const msg: SprinkleBridgeResponseMsg = { type: 'sprinkle-op-response', id };
    if (typeof error === 'string') msg.error = error;
    else msg.result = result;
    channel.postMessage(msg);
  };

  const handler = (event: MessageEvent): void => {
    const req = event.data as SprinkleBridgeRequestMsg | undefined;
    if (req?.type !== 'sprinkle-op-request') return;
    void (async () => {
      try {
        const { op, name, data, id } = req;
        switch (op) {
          case 'list':
            await manager.refresh();
            respond(id, manager.available());
            return;
          case 'opened':
            respond(id, manager.opened());
            return;
          case 'refresh':
            await manager.refresh();
            respond(id, manager.available().length);
            return;
          case 'open':
            await manager.open(name ?? '', undefined, req.openOptions);
            respond(id, true);
            return;
          case 'close':
            manager.close(name ?? '');
            respond(id, true);
            return;
          case 'send':
            respond(id, await manager.sendToSprinkle(name ?? '', data, req.target));
            return;
          case 'reload':
            await manager.reload(name ?? '');
            respond(id, true);
            return;
          case 'openNewAutoOpen':
            await manager.openNewAutoOpenSprinkles();
            respond(id, true);
            return;
          default:
            respond(req.id, null);
            return;
        }
      } catch (err) {
        respond(req.id, undefined, err instanceof Error ? err.message : String(err));
      }
    })();
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
