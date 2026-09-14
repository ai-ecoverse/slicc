import {
  SYNC_FS_ERRNO_HEADER as ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER as MARKER_HEADER,
  SYNC_FS_TOKEN_HEADER as TOKEN_HEADER,
} from './sync-fs-wire.js';

export function syncXhrError(code: string, label: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${label}`), { code });
}

export interface SyncXhrRequest {
  method: 'GET' | 'POST';

  url: string;

  token: string;

  body?: Uint8Array;

  timeoutMs: number;

  label: string;
}

export function synchronify(req: SyncXhrRequest): Uint8Array {
  const xhr = send(req);
  if (isGenuine(xhr)) return new Uint8Array(xhr.response as ArrayBuffer);

  if (xhr.status >= 200 && xhr.status < 300) throw syncXhrError('EIO', req.label);
  fail(xhr, req.label);
}

export function synchronifyJson(req: SyncXhrRequest): unknown {
  const bytes = synchronify(req);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw syncXhrError('EIO', req.label);
  }
}

function send(req: SyncXhrRequest): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  try {
    xhr.open(req.method, req.url, false);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = req.timeoutMs;
    xhr.setRequestHeader(TOKEN_HEADER, req.token);
    if (req.body) xhr.send(new Uint8Array(req.body));
    else xhr.send();
  } catch {
    throw syncXhrError('EIO', req.label);
  }
  return xhr;
}

function isGenuine(xhr: XMLHttpRequest): boolean {
  return xhr.status >= 200 && xhr.status < 300 && xhr.getResponseHeader(MARKER_HEADER) === '1';
}

function fail(xhr: XMLHttpRequest, label: string): never {
  const trusted = xhr.getResponseHeader(MARKER_HEADER) === '1';
  throw syncXhrError((trusted && xhr.getResponseHeader(ERRNO_HEADER)) || 'EIO', label);
}
