/** JSON-RPC 2.0 method call emitted from a stdin line (`--jsonrpc`). */
interface JsonRpcMethodCall {
  id: number;
  method: string;
  params: unknown;
  jsonrpc?: '2.0';
}

export function splitStdin(stdin: string, nullTerm: boolean): string[] {
  if (!stdin) return [];
  const sep = nullTerm ? '\0' : '\n';
  const parts = stdin.split(sep);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function buildJsonRpc(line: string, id: number, omit: boolean): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  const spaceIdx = trimmed.search(/\s/);
  const method = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  let params: unknown = [];
  if (rest) {
    try {
      params = JSON.parse(rest);
    } catch {
      params = [rest];
    }
  }
  const payload: JsonRpcMethodCall = { id, method, params };
  if (!omit) payload.jsonrpc = '2.0';
  return JSON.stringify(payload);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function bytesToTextSafe(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return bytesToBase64(bytes);
  }
}

export function messageDataToBytes(data: unknown): { bytes: Uint8Array; isBinary: boolean } {
  if (typeof data === 'string') {
    return { bytes: new TextEncoder().encode(data), isBinary: false };
  }
  if (data instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(data), isBinary: true };
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return {
      bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      isBinary: true,
    };
  }
  return { bytes: new TextEncoder().encode(String(data)), isBinary: false };
}
