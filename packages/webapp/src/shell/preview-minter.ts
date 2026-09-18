export interface MintPreviewOpts {
  entryPath: string;
  servedRoot: string;

  bridge: boolean;

  noBridge: boolean;

  maxTabs?: number;

  quiet?: boolean;

  webhookId?: string;
  ttlMs?: number;
  snapshotFiles?: Array<{ path: string; content: Uint8Array; mime: string }>;
}

export interface MintPreviewResult {
  url: string;
  pushed: number;

  previewToken: string;
}

export type PreviewMinter = (opts: MintPreviewOpts) => Promise<MintPreviewResult>;

let directMinter: PreviewMinter | null = null;

export function setPreviewMinter(minter: PreviewMinter | null): void {
  directMinter = minter;
}

export function getPreviewMinter(): PreviewMinter | null {
  return directMinter;
}

export interface PreviewOpRequest {
  type: 'stop' | 'list' | 'logs' | 'truncate';
  previewToken?: string;
}

export interface PreviewLifecycleRecordResult {
  timestamp: string;
  lifecycle: 'connected' | 'disconnected';
  connId: string;
  previewToken?: string;
  origin?: string;
  userAgent?: string;
  connectedAt?: string;
  reason?: string;
  announced: boolean;
}

export interface PreviewOpListItem {
  previewToken: string;
  url: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  createdAt: string;
  mode?: 'live' | 'persistent';
  state?: 'pending' | 'ready' | 'cleanup';
  expiresAt?: string;
}

export interface PreviewOpResult {
  revoked?: boolean;
  previews?: PreviewOpListItem[];
  lifecycleRecords?: PreviewLifecycleRecordResult[];
  cleared?: number;
  rearmed?: number;

  webhookId?: string;
}

export type PreviewOp = (req: PreviewOpRequest) => Promise<PreviewOpResult>;

let directOp: PreviewOp | null = null;

export function setPreviewOp(op: PreviewOp | null): void {
  directOp = op;
}

export function getPreviewOp(): PreviewOp | null {
  return directOp;
}
