/**
 * `multipart-form-data.ts` — the single `multipart/form-data` serializer.
 *
 * `SecureFetch` (and the realm's `fetch` RPC that funnels into it) can only
 * carry a `string` body, so every binary payload rides the latin1 convention
 * (one character per byte). That transport can express multipart fine — what
 * was missing was the *serialization* step, which is why `fetch(url, { body:
 * new FormData() })` used to throw in `.jsh` even though `FormData`, `File`,
 * and `Blob` are all constructible globals there.
 *
 * The boundary token is minted here, in the same call that produces the bytes,
 * and returned alongside them as a ready-made `Content-Type` value. Callers
 * must never generate their own: a boundary that disagrees with the delimiters
 * in the body makes the request unparseable server-side, and splitting the two
 * across functions is exactly how that drifts.
 *
 * Escaping follows the WHATWG `multipart/form-data` encoding algorithm (the
 * one `undici` and browsers implement): newlines in names and string values
 * normalize to CRLF, and `"` / CR / LF inside `name=` / `filename=` become
 * `%22` / `%0D` / `%0A` so a crafted field name cannot forge a part header.
 */

const CRLF = '\r\n';

/** A `Blob`/`File`-shaped part: raw bytes plus its filename and MIME type. */
export interface MultipartFilePart {
  bytes: Uint8Array;
  filename: string;
  /** Defaults to `application/octet-stream` when empty. */
  contentType?: string;
}

/** One `multipart/form-data` entry — a text field or a file part. */
export type MultipartPart =
  | { name: string; value: string }
  | { name: string; file: MultipartFilePart };

/** Assembled multipart body plus the `Content-Type` that describes it. */
export interface EncodedMultipartBody {
  bytes: Uint8Array;
  /** Full header value with the boundary baked in. */
  contentType: string;
  boundary: string;
}

/**
 * Mint a fresh boundary token. 128 bits of randomness keeps an accidental
 * collision with the payload out of practical reach (the RFC forbids the
 * delimiter appearing in any part), and the 53-character result stays inside
 * the RFC 2046 70-character cap using only `bcharsnospace` characters.
 */
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

/** Narrow a `BodyInit`-ish value to `FormData` without assuming the global exists. */
export function isFormDataBody(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

/**
 * Serialize `parts` into a multipart body. Synchronous on purpose: callers
 * that already hold bytes (e.g. a mount backend wrapping one file) do not
 * need to build a `FormData` first. Pass `boundary` only from a test that
 * needs a deterministic wire image.
 */
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

/**
 * Serialize a `FormData` into multipart bytes. Async because `File`/`Blob`
 * entry values only expose their bytes through `await .arrayBuffer()`.
 */
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
    // `FormData.append(name, blob)` already names a bare Blob "blob" per spec,
    // but non-spec FormData shims occasionally hand back a plain Blob.
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

/** Collapse lone CR and lone LF to CRLF, leaving existing CRLF pairs alone. */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, CRLF);
}

/**
 * Percent-escape the three characters that would otherwise break out of a
 * quoted `name=` / `filename=` parameter and forge a new part header.
 */
function escapeHeaderParam(value: string): string {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}

/**
 * Strip CR/LF from a caller-supplied part MIME type. `Blob.type` is already
 * constrained to printable ASCII by its constructor, but `encodeMultipartParts`
 * also takes types derived from filenames, and a header value must not be able
 * to inject a line break.
 */
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
