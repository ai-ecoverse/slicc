const CRLF = '\r\n';

export interface MultipartFilePart {
  bytes: Uint8Array;
  filename: string;

  contentType?: string;
}

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; file: MultipartFilePart };

export interface EncodedMultipartBody {
  bytes: Uint8Array;

  contentType: string;
  boundary: string;
}

export function generateMultipartBoundary(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `----SliccFormBoundary${hex}`;
}

export function isFormDataBody(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

export function encodeMultipartParts(
  parts: readonly MultipartPart[],
  boundary: string = generateMultipartBoundary()
): EncodedMultipartBody {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const name = escapeHeaderParam(normalizeNewlines(part.name));
    if ('file' in part) {
      const filename = escapeHeaderParam(part.file.filename);
      const type = sanitizeContentType(part.file.contentType) || 'application/octet-stream';
      chunks.push(
        encoder.encode(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}` +
            `Content-Type: ${type}${CRLF}${CRLF}`
        )
      );
      chunks.push(part.file.bytes);
      chunks.push(encoder.encode(CRLF));
    } else {
      chunks.push(
        encoder.encode(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
            `${normalizeNewlines(part.value)}${CRLF}`
        )
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--${CRLF}`));
  return {
    bytes: concatBytes(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
  };
}

export async function encodeMultipartFormData(
  form: FormData,
  boundary: string = generateMultipartBoundary()
): Promise<EncodedMultipartBody> {
  const parts: MultipartPart[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push({ name, value });
      continue;
    }

    const filename = typeof (value as File).name === 'string' ? (value as File).name : 'blob';
    parts.push({
      name,
      file: {
        bytes: new Uint8Array(await value.arrayBuffer()),
        filename,
        contentType: value.type || undefined,
      },
    });
  }
  return encodeMultipartParts(parts, boundary);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, CRLF);
}

function escapeHeaderParam(value: string): string {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}

function sanitizeContentType(contentType: string | undefined): string {
  return (contentType ?? '').replace(/[\r\n]/g, '').trim();
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
