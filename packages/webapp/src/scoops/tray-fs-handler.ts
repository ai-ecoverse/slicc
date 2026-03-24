/**
 * Pure VFS request handler for tray fs sync protocol.
 *
 * Takes a VirtualFS instance + a TrayFsRequest and returns a TrayFsResponse.
 * This module is intentionally free of data-channel or routing concerns
 * so it can be tested without FakeChannel infrastructure.
 */

import type { VirtualFS } from '../fs/virtual-fs.js';
import type { TrayFsRequest, TrayFsResponse, TrayFsResponseData } from './tray-sync-protocol.js';

/**
 * Chunk size threshold in serialized characters.
 *
 * This handler chunks the string payload that goes over the tray sync channel:
 * UTF-8 reads chunk decoded text, and binary reads chunk base64 text.
 */
const CHUNK_THRESHOLD_CHARS = 64 * 1024;

/**
 * Execute a single TrayFsRequest against a VirtualFS instance.
 * Returns one or more TrayFsResponse objects (multiple when chunking large files).
 */
export async function handleFsRequest(
  vfs: VirtualFS,
  request: TrayFsRequest
): Promise<TrayFsResponse[]> {
  try {
    switch (request.op) {
      case 'readFile':
        return await handleReadFile(vfs, request.path, request.encoding);
      case 'writeFile':
        return [await handleWriteFile(vfs, request.path, request.content, request.encoding)];
      case 'stat':
        return [await handleStat(vfs, request.path)];
      case 'readDir':
        return [await handleReadDir(vfs, request.path)];
      case 'mkdir':
        return [await handleMkdir(vfs, request.path, request.recursive)];
      case 'rm':
        return [await handleRm(vfs, request.path, request.recursive)];
      case 'exists':
        return [await handleExists(vfs, request.path)];
      case 'walk':
        return [await handleWalk(vfs, request.path)];
      default:
        return [{ ok: false, error: `Unknown fs operation: ${(request as { op: string }).op}` }];
    }
  } catch (err) {
    return [errorResponse(err)];
  }
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

async function handleReadFile(
  vfs: VirtualFS,
  path: string,
  encoding?: 'utf-8' | 'binary'
): Promise<TrayFsResponse[]> {
  const enc = encoding ?? 'utf-8';
  if (enc === 'utf-8') {
    const text = (await vfs.readFile(path, { encoding: 'utf-8' })) as string;
    return chunkContent(text, 'utf-8');
  }
  // Binary — read as Uint8Array and base64-encode
  const data = (await vfs.readFile(path, { encoding: 'binary' })) as Uint8Array;
  const b64 = uint8ToBase64(data);
  return chunkContent(b64, 'base64');
}

async function handleWriteFile(
  vfs: VirtualFS,
  path: string,
  content: string,
  encoding: 'utf-8' | 'base64'
): Promise<TrayFsResponse> {
  if (encoding === 'base64') {
    const data = base64ToUint8(content);
    await vfs.writeFile(path, data);
  } else {
    await vfs.writeFile(path, content);
  }
  return { ok: true, data: { type: 'void' } };
}

async function handleStat(vfs: VirtualFS, path: string): Promise<TrayFsResponse> {
  const s = await vfs.stat(path);
  return { ok: true, data: { type: 'stat', stat: s } };
}

async function handleReadDir(vfs: VirtualFS, path: string): Promise<TrayFsResponse> {
  const entries = await vfs.readDir(path);
  return { ok: true, data: { type: 'dirEntries', entries } };
}

async function handleMkdir(
  vfs: VirtualFS,
  path: string,
  recursive?: boolean
): Promise<TrayFsResponse> {
  await vfs.mkdir(path, { recursive });
  return { ok: true, data: { type: 'void' } };
}

async function handleRm(
  vfs: VirtualFS,
  path: string,
  recursive?: boolean
): Promise<TrayFsResponse> {
  await vfs.rm(path, { recursive });
  return { ok: true, data: { type: 'void' } };
}

async function handleExists(vfs: VirtualFS, path: string): Promise<TrayFsResponse> {
  const exists = await vfs.exists(path);
  return { ok: true, data: { type: 'exists', exists } };
}

async function handleWalk(vfs: VirtualFS, path: string): Promise<TrayFsResponse> {
  const paths: string[] = [];
  for await (const p of vfs.walk(path)) {
    paths.push(p);
  }
  return { ok: true, data: { type: 'paths', paths } };
}

// ---------------------------------------------------------------------------
// Chunking helpers
// ---------------------------------------------------------------------------

/**
 * Split serialized file content into chunks if it exceeds CHUNK_THRESHOLD_CHARS.
 * Each chunk is a separate TrayFsResponse with chunkIndex/totalChunks.
 */
function chunkContent(content: string, encoding: 'utf-8' | 'base64'): TrayFsResponse[] {
  if (content.length <= CHUNK_THRESHOLD_CHARS) {
    return [{ ok: true, data: { type: 'file', content, encoding } }];
  }

  const totalChunks = Math.ceil(content.length / CHUNK_THRESHOLD_CHARS);
  const responses: TrayFsResponse[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_THRESHOLD_CHARS;
    const chunk = content.slice(start, start + CHUNK_THRESHOLD_CHARS);
    responses.push({
      ok: true,
      data: { type: 'file', content: chunk, encoding },
      chunkIndex: i,
      totalChunks,
    });
  }
  return responses;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function errorResponse(err: unknown): TrayFsResponse {
  if (err instanceof Error && 'code' in err) {
    return { ok: false, error: err.message, code: (err as Error & { code: string }).code };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Base64 helpers (browser-compatible, no Buffer)
// ---------------------------------------------------------------------------

/** Encode Uint8Array to base64 string (browser-safe). */
export function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/** Decode base64 string to Uint8Array (browser-safe). */
export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
