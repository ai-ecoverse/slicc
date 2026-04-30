/**
 * AWS SigV4 v4 signing — node-server copy.
 *
 * **Mirrored from `packages/webapp/src/fs/mount/signing-s3.ts`.** Both files
 * are byte-for-byte equivalent in behavior and must stay in sync. The reason
 * for two copies is that `tsconfig.cli.json` pins `rootDir` to
 * `packages/node-server/src`, so cross-importing the webapp source under
 * NodeNext resolution is rejected by the compiler. Sharing via a workspace
 * package is a larger change than this PR's scope.
 *
 * Drift between the two copies is caught by both test suites running the
 * same canonical AWS test vectors:
 *  - `packages/webapp/tests/fs/mount/signing-s3.test.ts`
 *  - `packages/node-server/tests/secrets/signing-s3.test.ts`
 *
 * If you change one, change the other and verify both test suites pass.
 *
 * Pure function — given a request + credentials + region + service + clock,
 * produces the same request with an `Authorization` header attached. Uses
 * Web Crypto (`crypto.subtle`) which works in browsers, extension service
 * workers, and Node 22+ (where it lives on `globalThis.crypto`).
 */

export interface SigV4Request {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  url: URL;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const SIGNED_ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

// Web Crypto's `BufferSource` is the DOM alias `ArrayBuffer | ArrayBufferView`;
// in TS 6 the `Uint8Array<ArrayBufferLike>` generic doesn't narrow to that
// directly because `ArrayBufferLike` includes `SharedArrayBuffer`. We never
// pass a `SharedArrayBuffer` here, so the cast is sound. Defined locally so
// node-server (no DOM lib) typechecks with the same name as the browser.
type SubtleData = ArrayBufferView<ArrayBuffer>;

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as SubtleData);
  return hex(digest);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer | SubtleData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function ymd(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function iso8601(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Canonicalize a path: percent-encode each segment per RFC 3986 except
 * preserve `/`. The input `URL.pathname` is already URL-decoded by the
 * URL parser, so we re-encode here.
 */
function canonicalUri(url: URL): string {
  const segments = url.pathname.split('/');
  const encoded = segments.map((s) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    )
  );
  const path = encoded.join('/');
  return path === '' ? '/' : path;
}

/**
 * Build the canonical query string: sort by key then by value, percent-
 * encode keys and values per RFC 3986.
 */
function canonicalQuery(url: URL): string {
  const params: [string, string][] = [];
  for (const [k, v] of url.searchParams.entries()) {
    params.push([k, v]);
  }
  params.sort(([ak, av], [bk, bv]) =>
    ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1
  );
  return params
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k).replace(/\+/g, '%20')}=${encodeURIComponent(v).replace(/\+/g, '%20')}`
    )
    .join('&');
}

/**
 * Canonicalize headers: lowercase keys, trim/collapse internal whitespace
 * in values, sort by key. Returns both the canonical string and the
 * semicolon-joined signed-headers list.
 */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers).map(
    ([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as [string, string]
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signed = entries.map(([k]) => k).join(';');
  return { canonical, signed };
}

export async function signSigV4(
  req: SigV4Request,
  creds: SigV4Credentials,
  region: string,
  service: string = 's3',
  now: Date = new Date()
): Promise<SigV4Request> {
  const date = ymd(now);
  const dateTime = iso8601(now);

  const bodyBytes = req.body ?? new Uint8Array(0);
  const bodyHash = bodyBytes.byteLength === 0 ? EMPTY_BODY_HASH : await sha256(bodyBytes);

  const headers: Record<string, string> = {
    ...req.headers,
    host: req.headers.host ?? req.headers.Host ?? req.url.host,
    'x-amz-date': dateTime,
  };
  // S3 (and a few related services) requires `x-amz-content-sha256` in the
  // canonical request. The generic `service` name used by AWS's SigV4 v4
  // test suite does not — gate on service name so our impl verifies cleanly
  // against the canonical test vectors.
  if (service === 's3') {
    headers['x-amz-content-sha256'] = bodyHash;
  }
  if (creds.sessionToken) {
    headers['x-amz-security-token'] = creds.sessionToken;
  }
  // canonicalHeaders lowercases keys; remove any pre-existing mixed-case
  // Host so we don't double-count it.
  delete headers.Host;

  const { canonical: canonicalHeadersStr, signed: signedHeaders } = canonicalHeaders(headers);
  const canonicalRequest = [
    req.method,
    canonicalUri(req.url),
    canonicalQuery(req.url),
    canonicalHeadersStr,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    SIGNED_ALGORITHM,
    dateTime,
    credentialScope,
    await sha256(new TextEncoder().encode(canonicalRequest)),
  ].join('\n');

  // Derive signing key: kDate, kRegion, kService, kSigning.
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${creds.secretAccessKey}`), date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = hex(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `${SIGNED_ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...req,
    headers: {
      ...headers,
      Authorization: authorization,
    },
  };
}
