import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage } from '@slicc/shared-ts';
import { mcpServeInstanceId } from './serve-instance.js';

export type BridgeMessage =
  | { kind: 'publish'; id: string; grantGeneration: number }
  | {
      kind: 'publish-result';
      id: string;
      ok: boolean;
      url?: string;
      token?: string;
      error?: string;
    }
  | { kind: 'stop'; id: string }
  | { kind: 'stop-result'; id: string; ok: boolean; error?: string }
  | { kind: 'call'; id: string; op: 'rpc' | 'consent'; body: string }
  | { kind: 'call-result'; id: string; status: number; contentType: string; body: string }
  | { kind: 'page-ready' }
  | { kind: 'kernel-ready' };

export interface McpChannel {
  postMessage(data: BridgeMessage): void;
  addEventListener(type: 'message', listener: (event: { data: BridgeMessage }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: BridgeMessage }) => void): void;
  close(): void;
}

export interface McpCallResult {
  status: number;
  contentType: string;
  body: string;
}

const PUBLISH_WAIT_MS = 12_000;
const CALL_WAIT_MS = 110_000;

type CallHandler = (op: 'rpc' | 'consent', body: string) => Promise<McpCallResult>;

let opener: (name: string) => McpChannel = (name) =>
  new BroadcastChannel(name) as unknown as McpChannel;
let kernelChannel: McpChannel | null = null;
let pageChannel: McpChannel | null = null;
let pageSend: ((message: LeaderToWorkerControlMessage) => void) | null = null;
let pageWorkerBaseUrl = '';
let callHandler: CallHandler | null = null;
let pageReadyHook: (() => void) | null = null;
const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function mcpServeChannelName(instanceId: string | null): string {
  return instanceId ? `slicc-mcp-serve:${instanceId}` : 'slicc-mcp-serve';
}

export function setMcpServeChannelOpener(next: (name: string) => McpChannel): void {
  opener = next;
}

export function installMcpServeKernel(handler: CallHandler, onPageReady: () => void): void {
  callHandler = handler;
  pageReadyHook = onPageReady;
  openKernelChannel();
}

export function requestPublish(
  grantGeneration: number,
  timeoutMs = 15_000
): Promise<{ url: string; token: string }> {
  return waitForResult(
    openKernelChannel(),
    { kind: 'publish', id: crypto.randomUUID(), grantGeneration },
    timeoutMs
  );
}

export function requestStop(timeoutMs = 15_000): Promise<void> {
  const id = crypto.randomUUID();
  return waitForResult(openKernelChannel(), { kind: 'stop', id }, timeoutMs).then(() => undefined);
}

export function installMcpServePage(options: {
  instanceId: string | null;
  workerBaseUrl: string;
  send: (message: LeaderToWorkerControlMessage) => void;
}): () => void {
  pageSend = options.send;
  pageWorkerBaseUrl = options.workerBaseUrl;
  pageChannel?.close();
  pageChannel = opener(mcpServeChannelName(options.instanceId));
  pageChannel.addEventListener('message', (event) => {
    onPageMessage(event.data);
  });
  pageChannel.postMessage({ kind: 'page-ready' });
  return () => {
    pageChannel?.close();
    pageChannel = null;
    pageSend = null;
  };
}

export function dispatchMcpServeControl(message: WorkerToLeaderControlMessage): boolean {
  if (message.type === 'mcp.published') {
    finishTimer(publishTimers, message.requestId);
    pageChannel?.postMessage({
      kind: 'publish-result',
      id: message.requestId,
      ok: message.url.length > 0 && message.token.length > 0,
      url: message.url,
      token: message.token,
      ...(message.url ? {} : { error: 'preview host is not configured for this worker' }),
    });
    return true;
  }
  if (message.type === 'mcp.stopped') {
    finishTimer(stopTimers, message.requestId);
    pageChannel?.postMessage({ kind: 'stop-result', id: message.requestId, ok: true });
    return true;
  }
  if (message.type === 'mcp.request') {
    void forwardCall(message.reqId, message.op, message.body);
    return true;
  }
  return false;
}

function openKernelChannel(): McpChannel {
  if (kernelChannel) return kernelChannel;
  kernelChannel = opener(mcpServeChannelName(mcpServeInstanceId()));
  kernelChannel.addEventListener('message', (event) => {
    void onKernelMessage(event.data);
  });

  kernelChannel.postMessage({ kind: 'kernel-ready' });
  return kernelChannel;
}

async function onKernelMessage(data: BridgeMessage): Promise<void> {
  if (!data || typeof data !== 'object') return;
  if (data.kind === 'page-ready') {
    pageReadyHook?.();
    return;
  }
  if (data.kind !== 'call' || !callHandler) return;
  try {
    const result = await callHandler(data.op, data.body);
    kernelChannel?.postMessage({ kind: 'call-result', id: data.id, ...result });
  } catch (err) {
    kernelChannel?.postMessage({
      kind: 'call-result',
      id: data.id,
      status: 500,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'mcp call failed' }),
    });
  }
}

function onPageMessage(data: BridgeMessage): void {
  if (!data || typeof data !== 'object') return;
  if (data.kind === 'kernel-ready') {
    pageChannel?.postMessage({ kind: 'page-ready' });
    return;
  }
  if (data.kind === 'publish') {
    armLeaderRoundTrip('publish', publishTimers, data.id, 'mcp publish timed out', () => {
      pageSend?.({
        type: 'mcp.publish',
        requestId: data.id,
        grantGeneration: data.grantGeneration,
        workerBaseUrl: pageWorkerBaseUrl,
      });
    });
    return;
  }
  if (data.kind === 'stop') {
    armLeaderRoundTrip('stop', stopTimers, data.id, 'mcp stop timed out', () => {
      pageSend?.({ type: 'mcp.stop', requestId: data.id });
    });
    return;
  }
}

function armLeaderRoundTrip(
  kind: 'publish' | 'stop',
  timers: Map<string, ReturnType<typeof setTimeout>>,
  id: string,
  error: string,
  send: () => void
): void {
  const resultKind = kind === 'publish' ? 'publish-result' : 'stop-result';
  if (!pageSend || (kind === 'publish' && !pageWorkerBaseUrl)) {
    pageChannel?.postMessage({
      kind: resultKind,
      id,
      ok: false,
      error: 'leader tray is not connected',
    });
    return;
  }
  send();
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      pageChannel?.postMessage({ kind: resultKind, id, ok: false, error });
    }, PUBLISH_WAIT_MS)
  );
}

function finishTimer(timers: Map<string, ReturnType<typeof setTimeout>>, id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

async function forwardCall(reqId: string, op: 'rpc' | 'consent', body: string): Promise<void> {
  const id = crypto.randomUUID();
  const channel = pageChannel;
  const result = await new Promise<McpCallResult>((resolve) => {
    const timer = setTimeout(() => {
      channel?.removeEventListener('message', onMessage);
      resolve({
        status: 504,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: 'kernel timeout' }),
      });
    }, CALL_WAIT_MS);
    const onMessage = (event: { data: BridgeMessage }) => {
      if (event.data?.kind !== 'call-result' || event.data.id !== id) return;
      clearTimeout(timer);
      channel?.removeEventListener('message', onMessage);
      resolve({
        status: event.data.status,
        contentType: event.data.contentType,
        body: event.data.body,
      });
    };
    channel?.addEventListener('message', onMessage);
    channel?.postMessage({ kind: 'call', id, op, body });
  });
  pageSend?.({
    type: 'mcp.response',
    reqId,
    status: result.status,
    contentType: result.contentType,
    body: result.body,
  });
}

function waitForResult(
  channel: McpChannel,
  message: Extract<BridgeMessage, { kind: 'publish' | 'stop' }>,
  timeoutMs: number
): Promise<{ url: string; token: string }> {
  const id = message.id;
  const wanted = message.kind === 'publish' ? 'publish-result' : 'stop-result';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener('message', onMessage);
      reject(new Error(`mcp ${message.kind} timed out`));
    }, timeoutMs);
    const onMessage = (event: { data: BridgeMessage }) => {
      const data = event.data;
      if (!data || data.kind !== wanted || data.id !== id) return;
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      if (!data.ok) {
        reject(new Error(data.error || `mcp ${message.kind} failed`));
        return;
      }
      resolve({
        url: data.kind === 'publish-result' ? (data.url ?? '') : '',
        token: data.kind === 'publish-result' ? (data.token ?? '') : '',
      });
    };
    channel.addEventListener('message', onMessage);
    channel.postMessage(message);
  });
}
