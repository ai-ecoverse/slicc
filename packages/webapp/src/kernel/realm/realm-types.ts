import type { SyncFsToken } from './sync-fs-wire.js';

export type RealmKind = 'js' | 'py';

export interface RealmInitMsg {
  type: 'realm-init';
  kind: RealmKind;

  code: string;

  argv: string[];

  env: Record<string, string>;

  cwd: string;

  filename: string;

  syncFsToken?: SyncFsToken;

  syncSab?: SharedArrayBuffer;

  stdin?: string;

  pyodideIndexURL?: string;

  pyodideAssetRoot?: string;

  pyodideMountDirs?: string[];

  opfsMountDbName?: string;

  mountPoints?: RealmMountPoint[];
}

export interface RealmMountPoint {
  path: string;

  kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem';
}

export interface RealmDoneMsg {
  type: 'realm-done';
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RealmErrorMsg {
  type: 'realm-error';
  message: string;
}

export type RealmRpcChannel =
  | 'vfs'
  | 'exec'
  | 'fetch'
  | 'browser'
  | 'usb'
  | 'serial'
  | 'hid'
  | 'module'
  | 'wasm';

export interface RealmModuleGraph {
  files: { path: string; cjsSource: string; kind: string }[];
  entryMap: Record<string, string>;
  edges: Record<string, Record<string, string>>;
  edgeErrors: Record<string, Record<string, string>>;
  errors: Record<string, string>;

  entrySource?: string;
}

export interface TabHandle {
  targetId: string;
  url: string;
  title: string;
}

export interface RealmRpcRequest {
  type: 'realm-rpc-req';
  id: number;
  channel: RealmRpcChannel;
  op: string;
  args: unknown[];
}

export interface RealmRpcResponse {
  type: 'realm-rpc-res';
  id: number;

  result?: unknown;

  error?: string;
}

export interface RealmEventMsg {
  type: 'realm-event';
  channel: string;
  payload: unknown;
}

export interface SerializedFetchResponse {
  status: number;
  statusText: string;

  headers: Record<string, string>;

  body: Uint8Array;

  url: string;
}

export interface WsFrameTemplate {
  [key: string]: unknown;
}

export interface WsSelector {
  parseAs?: 'json' | 'text';

  where?: WsFrameTemplate;

  project?: readonly string[];
}

export type WsSink =
  | { sink: 'webhook'; webhookId: string }
  | { sink: 'scoop'; scoopJid: string }
  | { sink: 'vfs'; path: string }
  | { sink: 'log' };

export interface WsObserveRequest {
  targetId: string;
  urlMatch?: string;
  filter?: WsSelector;
  forward: WsSink;

  scoopJid?: string;
}

export interface WsSubscriberInfo {
  id: string;
  targetId: string;
  urlMatch?: string;
  filter?: WsSelector;
  forward: WsSink;
  scoopJid?: string;
  createdAt: string;
}

export type RealmOutbound = RealmDoneMsg | RealmErrorMsg | RealmRpcRequest;

export type RealmInbound = RealmInitMsg | RealmRpcResponse | RealmEventMsg;
