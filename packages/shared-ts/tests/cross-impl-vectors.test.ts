import { describe, expect, it } from 'vitest';
import { isTextRequestContentType } from '../src/content-type.js';
import { unmaskFormBody } from '../src/form-body-unmask.js';
import {
  decodeRawRequestHead,
  encodeRawResponseFrame,
  foldRawRequestHeaders,
  type RawFetchRequestHead,
  type RawFetchResponseHead,
  rawResponseHeaders,
  stripRawRequestHeaders,
} from '../src/raw-fetch-protocol.js';
import { rawUploadStreams } from '../src/raw-fetch-upload.js';
import { isSingleLineSecretValue, multilineSecretValueError } from '../src/secret-env-schema.js';
import { isAllowedDomain, mask, secretScopeHostname } from '../src/secret-masking.js';
import { type FetchProxySecretSource, SecretsPipeline } from '../src/secrets-pipeline.js';

/**
 * Pinned cross-implementation mask vectors.
 *
 * The same vectors are pinned in
 * `packages/swift-server/Tests/CrossImplementationTests.swift`.
 *
 * Regenerate with:
 *   npm run build -w @slicc/shared-ts
 *   node packages/dev-tools/tools/gen-mask-vectors.mjs
 *
 * Update BOTH this file and the Swift sibling whenever the masking
 * algorithm changes intentionally. A drift between the two implementations
 * causes silent unmask failures in the fetch proxy.
 */
const PINNED = [
  {
    sessionId: 'session-cross-impl-1',
    name: 'GITHUB_TOKEN',
    value: 'ghp_realToken123',
    expected: 'ghp_25243876bf81',
  },
  {
    sessionId: 'session-cross-impl-2',
    name: 'AWS_KEY',
    value: 'AKIAEXAMPLE',
    expected: 'AKIAc418a4f',
  },
  {
    sessionId: '',
    name: 'X',
    value: '',
    expected: '',
  },
  {
    sessionId: 'session-😀',
    name: 'Y',
    value: 'value with spaces',
    expected: '3a7af4ae08a5ccb55',
  },
  // Pin the UTF-16 code-unit length contract: an emoji is 2 code units
  // in JS String.length (`tok🎉end` = 8), 1 grapheme in Swift String.count
  // (= 7). Swift uses `.utf16.count` for parity; this vector catches a
  // regression to grapheme-counting in either implementation.
  {
    sessionId: 'session-utf16',
    name: 'EMOJI_VALUE',
    value: 'tok🎉end',
    expected: 'd2317bc7',
  },
];

describe('cross-implementation mask vectors', () => {
  it.each(PINNED)(
    'mask($sessionId, $name) is stable',
    async ({ sessionId, name, value, expected }) => {
      expect(await mask(sessionId, name, value)).toBe(expected);
    }
  );
});

/**
 * Pinned request-body text/binary classification table.
 *
 * The same table is pinned in `CrossImplementationTests.swift`
 * (`testIsTextRequestContentTypeMatchesPinnedTable`). Node's fetch proxy and
 * swift-server's must agree on which request bodies get a masked→real unmask
 * pass; when they drift, a form POST that works on Sliccstart ships the masked
 * token upstream on the Node CLI (#2821).
 */
const REQUEST_CONTENT_TYPE_TABLE: [contentType: string, isText: boolean][] = [
  ['application/x-www-form-urlencoded', true],
  ['application/x-www-form-urlencoded;charset=UTF-8', true],
  ['Application/X-WWW-Form-Urlencoded', true],
  ['application/json', true],
  ['application/json; charset=utf-8', true],
  ['text/plain', true],
  ['application/xml', true],
  ['image/svg+xml', true],
  ['application/javascript', true],
  ['application/ecmascript', true],
  ['text/html', true],
  ['text/css', true],
  // Unlabeled bodies are binary on both floats: the byte-safe unmask path
  // handles them without a lossy UTF-8 round-trip.
  ['', false],
  ['image/jpeg', false],
  ['application/octet-stream', false],
  ['application/pdf', false],
  ['multipart/form-data; boundary=x', false],
  ['application/x-git-receive-pack-request', false],
];

describe('cross-implementation request content-type table', () => {
  it.each(REQUEST_CONTENT_TYPE_TABLE)(
    'isTextRequestContentType(%j) is %s',
    (contentType, isText) => {
      expect(isTextRequestContentType(contentType)).toBe(isText);
    }
  );
});

/**
 * Pinned form-body unmask substitution table.
 *
 * The same table is pinned in `CrossImplementationTests.swift`
 * (`testUnmaskFormBodyMatchesPinnedTable`). Both floats must percent-encode a
 * substituted secret identically — the real value below carries every
 * form-reserved character, so a drift in either the encoder's allowed set or
 * the field walk shows up as a different expected string.
 *
 * `%MASKED%` stands for the masked token, which is derived at runtime from the
 * already-pinned `mask()`.
 */
const FORM_SESSION = 'session-form-parity';
const FORM_REAL = 'ab+cd/ef=gh&ij kl%mn';
const FORM_ENCODED = 'ab%2Bcd%2Fef%3Dgh%26ij%20kl%25mn';

const FORM_BODY_TABLE: [input: string, expected: string][] = [
  [
    'token=%MASKED%&grant_type=client_credentials',
    `token=${FORM_ENCODED}&grant_type=client_credentials`,
  ],
  ['%MASKED%', FORM_ENCODED],
  ['a=%MASKED%&b=keep&c=%MASKED%', `a=${FORM_ENCODED}&b=keep&c=${FORM_ENCODED}`],
  // No masked token: forwarded byte-identical, `+` and `%2F` untouched.
  ['a=1&b=hello+world&c=%2Fpath', 'a=1&b=hello+world&c=%2Fpath'],
  ['a=&b=', 'a=&b='],
];

describe('cross-implementation form-body unmask table', () => {
  const source: FetchProxySecretSource = {
    get: async (name) => (name === 'FORM_SECRET' ? FORM_REAL : undefined),
    listAll: async () => [{ name: 'FORM_SECRET', value: FORM_REAL, domains: ['api.example.com'] }],
  };

  it.each(FORM_BODY_TABLE)('unmaskFormBody(%j)', async (input, expected) => {
    const pipeline = new SecretsPipeline({ sessionId: FORM_SESSION, source });
    await pipeline.reload();
    const masked = await mask(FORM_SESSION, 'FORM_SECRET', FORM_REAL);
    const body = input.split('%MASKED%').join(masked);
    const { text } = unmaskFormBody(pipeline, body, 'api.example.com');
    expect(text).toBe(expected);
  });
});

/**
 * Pinned multiline secret-value rejection parity.
 *
 * The same table is pinned in
 * `packages/swift-server/Tests/CrossImplementationTests.swift`.
 *
 * The secret `.env` schema is line-oriented on both sides, so a value carrying
 * a line break cannot round-trip: it serializes with a real LF inside its
 * quotes and parses back as the truncated first line. Both privileged servers
 * refuse such a value at the boundary instead of reporting success over a
 * corrupted credential (#2828). If only one side rejects, `POST /api/secrets`
 * silently eats a PEM key on one float that the other 400s — the divergence
 * this pairing exists to prevent.
 */
const SINGLE_LINE_TABLE: { value: string; isSingleLine: boolean }[] = [
  { value: 'ghp_realToken123', isSingleLine: true },
  { value: '', isSingleLine: true },
  { value: 'value with spaces', isSingleLine: true },
  { value: 'has#hash and "quotes"', isSingleLine: true },
  { value: 'tok🎉end', isSingleLine: true },
  { value: '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----', isSingleLine: false },
  { value: 'line1\nline2', isSingleLine: false },
  { value: 'trailing\n', isSingleLine: false },
  { value: '\nleading', isSingleLine: false },
  { value: 'crlf\r\nvalue', isSingleLine: false },
  { value: 'bare\rreturn', isSingleLine: false },
];

describe('cross-implementation multiline secret-value rejection', () => {
  it.each(SINGLE_LINE_TABLE)(
    'isSingleLineSecretValue($value) is $isSingleLine',
    ({ value, isSingleLine }) => {
      expect(isSingleLineSecretValue(value)).toBe(isSingleLine);
    }
  );

  // The rejection message is part of the wire contract — both servers return it
  // verbatim in the 400 body, so it is pinned alongside the predicate.
  it('pins the rejection message both servers return', () => {
    expect(multilineSecretValueError('PEM_KEY')).toBe(
      'Secret "PEM_KEY" value cannot contain newlines; the secret store is line-oriented and would truncate it to the first line'
    );
  });
});

/**
 * Pinned secret-scope hostnames: the name a secret's domain list is matched
 * against for a URL (WHATWG hostname: no port or userinfo, lowercase, IDN in
 * punycode, IPv6 bracketed). The same table is pinned in
 * `packages/swift-server/Tests/CrossImplementationTests.swift`.
 */
const SCOPE_HOSTNAMES = [
  { url: 'https://bücher.example:8443/x', hostname: 'xn--bcher-kva.example' },
  { url: 'https://u:p@BÜCHER.Example/', hostname: 'xn--bcher-kva.example' },
  { url: 'https://xn--bcher-kva.example/', hostname: 'xn--bcher-kva.example' },
  { url: 'https://API.GitHub.com/', hostname: 'api.github.com' },
  { url: 'http://upstream.test:65209/a', hostname: 'upstream.test' },
  { url: 'http://[::1]:5710/', hostname: '[::1]' },
];

const SCOPE_MATCHES = [
  { url: 'https://bücher.example/', patterns: ['xn--bcher-kva.example'], allowed: true },
  { url: 'https://uploads.github.com:8443/', patterns: ['*.github.com'], allowed: true },
  { url: 'https://github.com/', patterns: ['*.github.com'], allowed: false },
  { url: 'https://x:y@upstream.test:65209/', patterns: ['upstream.test'], allowed: true },
  { url: 'https://evil.test:8443/', patterns: ['upstream.test'], allowed: false },
];

describe('cross-implementation secret-scope hostnames', () => {
  it.each(SCOPE_HOSTNAMES)('$url → $hostname', ({ url, hostname }) => {
    expect(secretScopeHostname(url)).toBe(hostname);
  });

  it.each(SCOPE_MATCHES)('$url against $patterns → $allowed', ({ url, patterns, allowed }) => {
    expect(isAllowedDomain(patterns, secretScopeHostname(url))).toBe(allowed);
  });
});

/**
 * Pinned raw-fetch contract vectors (#3571): what a bridge puts on the wire in
 * raw mode. The same tables are pinned in
 * `packages/swift-server/Tests/CrossImplementationTests.swift`, so the
 * swift-server port (`RawFetchProtocol.swift`) answers exactly like node-server.
 */
type HeaderPairs = Array<[string, string]>;

/** Response heads and their frames as hex: u32 length, then `JSON.stringify` bytes. */
const RAW_FRAMES: Array<{ head: RawFetchResponseHead; hex: string }> = [
  {
    head: {
      status: 302,
      statusText: 'Found',
      headers: [
        ['location', '/next'],
        ['set-cookie', 'a=1; Path=/'],
        ['set-cookie', 'b=2'],
      ],
      url: 'https://example.test/start',
    },
    hex:
      '000000997b22737461747573223a3330322c2273746174757354657874223a22466f756e64222c226865616465' +
      '7273223a5b5b226c6f636174696f6e222c222f6e657874225d2c5b227365742d636f6f6b6965222c22613d313b' +
      '20506174683d2f225d2c5b227365742d636f6f6b6965222c22623d32225d5d2c2275726c223a2268747470733a' +
      '2f2f6578616d706c652e746573742f7374617274227d',
  },
  {
    head: {
      status: 200,
      statusText: '',
      headers: [
        ['x-escapes', 'q"b\\s/\b\f\n\r\t\u0001\u001f\u007f'],
        ['x-unicode', 'bücher 😀  '],
      ],
      url: 'https://bücher.example/',
    },
    hex:
      '0000009c7b22737461747573223a3230302c2273746174757354657874223a22222c2268656164657273223a5b' +
      '5b22782d65736361706573222c22715c22625c5c732f5c625c665c6e5c725c745c75303030315c75303031667f' +
      '225d2c5b22782d756e69636f6465222c2262c3bc6368657220f09f988020e280a8225d5d2c2275726c223a2268' +
      '747470733a2f2f62c3bc636865722e6578616d706c652f227d',
  },
];

/** `rawResponseHeaders` inputs and the head a raw caller sees. */
const RAW_RESPONSE_HEADERS: Array<{
  name: string;
  method: string;
  status: number;
  headers: HeaderPairs;
  bodyRewritten: boolean;
  decodedCodings: string[];
  expected: HeaderPairs;
}> = [
  {
    name: 'decoded gzip drops coding, length and hop fields',
    method: 'GET',
    status: 200,
    headers: [
      ['content-encoding', 'gzip'],
      ['content-length', '42'],
      ['connection', 'X-Hop, keep-alive'],
      ['x-hop', 'local'],
      ['keep-alive', 'timeout=5'],
      ['etag', '"v1"'],
    ],
    bodyRewritten: false,
    decodedCodings: ['gzip', 'deflate'],
    expected: [['etag', '"v1"']],
  },
  {
    name: 'HEAD keeps the representation headers',
    method: 'HEAD',
    status: 200,
    headers: [
      ['content-encoding', 'gzip'],
      ['content-length', '1234'],
    ],
    bodyRewritten: false,
    decodedCodings: ['gzip', 'deflate'],
    expected: [
      ['content-encoding', 'gzip'],
      ['content-length', '1234'],
    ],
  },
  {
    name: 'a coding the float does not undo stays with its length',
    method: 'GET',
    status: 200,
    headers: [
      ['Content-Encoding', 'br'],
      ['Content-Length', '6'],
    ],
    bodyRewritten: false,
    decodedCodings: ['gzip', 'deflate'],
    expected: [
      ['Content-Encoding', 'br'],
      ['Content-Length', '6'],
    ],
  },
  {
    name: 'identity coding goes, a rewritten body loses its length',
    method: 'GET',
    status: 200,
    headers: [
      ['content-encoding', 'identity'],
      ['content-length', '9'],
      ['content-type', 'text/plain'],
    ],
    bodyRewritten: true,
    decodedCodings: ['gzip', 'deflate'],
    expected: [['content-type', 'text/plain']],
  },
  {
    name: '304 keeps everything but hop fields',
    method: 'GET',
    status: 304,
    headers: [
      ['content-encoding', 'gzip'],
      ['transfer-encoding', 'chunked'],
    ],
    bodyRewritten: true,
    decodedCodings: ['gzip', 'deflate'],
    expected: [['content-encoding', 'gzip']],
  },
  {
    name: 'gzip then identity counts as decoded',
    method: 'GET',
    status: 200,
    headers: [
      ['content-encoding', 'gzip, identity'],
      ['content-length', '3'],
    ],
    bodyRewritten: false,
    decodedCodings: ['gzip', 'deflate'],
    expected: [],
  },
];

/** `foldRawRequestHeaders(stripRawRequestHeaders(input))`, in order. */
const RAW_REQUEST_HEADERS: { input: HeaderPairs; expected: HeaderPairs } = {
  input: [
    ['User-Agent', 'curl/8.22.0'],
    ['Cookie', 'a=1'],
    ['Accept-Encoding', 'zstd'],
    ['Connection', 'X-Hop, keep-alive'],
    ['X-Hop', 'drop me'],
    ['Host', 'example.test'],
    ['Content-Length', '3'],
    ['Expect', '100-continue'],
    ['TE', 'trailers'],
    ['cookie', 'b=2'],
    ['X-Multi', '1'],
    ['x-multi', '2'],
  ],
  expected: [
    ['user-agent', 'curl/8.22.0'],
    ['cookie', 'a=1; b=2'],
    ['x-multi', '1, 2'],
  ],
};

/** `X-Slicc-Raw-Request` values and what `decodeRawRequestHead` makes of them. */
const RAW_REQUEST_HEADS: Array<{ value: string; head: RawFetchRequestHead | null }> = [
  {
    value: String.raw`{"url":"https://bücher.example/","method":"PROPFIND","headers":[["X-Name","ü"]]}`,
    head: { url: 'https://bücher.example/', method: 'PROPFIND', headers: [['X-Name', 'ü']] },
  },
  {
    value: '{"url":"https://e.test/","method":"GET","headers":[]}',
    head: { url: 'https://e.test/', method: 'GET', headers: [] },
  },
  { value: '{"url":1,"method":"GET","headers":[]}', head: null },
  { value: '{"url":"https://e.test/","method":"GET /","headers":[]}', head: null },
  { value: '{"url":"https://e.test/","method":"","headers":[]}', head: null },
  { value: '{"url":"https://e.test/","method":"GET","headers":[["a"]]}', head: null },
  { value: '{"url":"https://e.test/","method":"GET","headers":[["a",1]]}', head: null },
  { value: '{"url":"https://e.test/","method":"GET","headers":[["a",true]]}', head: null },
  { value: '{"url":"https://e.test/","method":"GET"}', head: null },
  { value: '[]', head: null },
  { value: 'not json', head: null },
];

/** `rawUploadStreams` decisions. */
const RAW_UPLOAD_STREAMS: Array<{
  headers: HeaderPairs;
  bodyLength: number | null;
  canStream: boolean;
  streams: boolean;
}> = [
  {
    headers: [['Content-Type', 'application/octet-stream']],
    bodyLength: null,
    canStream: true,
    streams: true,
  },
  { headers: [], bodyLength: null, canStream: true, streams: true },
  {
    headers: [['Content-Type', 'application/json']],
    bodyLength: null,
    canStream: true,
    streams: false,
  },
  {
    headers: [
      ['Content-Type', 'application/octet-stream'],
      ['X-Slicc-Hmac-Sign', 'TOKEN:x-signature'],
    ],
    bodyLength: null,
    canStream: true,
    streams: false,
  },
  {
    headers: [['Content-Type', 'application/octet-stream']],
    bodyLength: 1024,
    canStream: true,
    streams: false,
  },
  {
    headers: [['Content-Type', 'application/octet-stream']],
    bodyLength: 8 * 1024 * 1024,
    canStream: true,
    streams: true,
  },
  {
    headers: [['Content-Type', 'application/octet-stream']],
    bodyLength: null,
    canStream: false,
    streams: false,
  },
];

describe('cross-implementation raw-fetch contract', () => {
  it.each(RAW_FRAMES)('frames a $head.status head byte for byte', ({ head, hex }) => {
    const bytes = [...encodeRawResponseFrame(head)];
    expect(bytes.map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(hex);
  });

  it.each(RAW_RESPONSE_HEADERS)('response head: $name', (vector) => {
    expect(
      rawResponseHeaders({
        method: vector.method,
        status: vector.status,
        headers: vector.headers,
        bodyRewritten: vector.bodyRewritten,
        decodedCodings: new Set(vector.decodedCodings),
      })
    ).toEqual(vector.expected);
  });

  it('strips and folds request headers', () => {
    const folded = foldRawRequestHeaders(stripRawRequestHeaders(RAW_REQUEST_HEADERS.input));
    expect(Object.entries(folded)).toEqual(RAW_REQUEST_HEADERS.expected);
  });

  it.each(RAW_REQUEST_HEADS)('decodes $value', ({ value, head }) => {
    expect(decodeRawRequestHead(value)).toEqual(head);
  });

  it.each(RAW_UPLOAD_STREAMS)('upload of $bodyLength bytes, $headers → $streams', (vector) => {
    expect(
      rawUploadStreams({
        headers: vector.headers,
        bodyLength: vector.bodyLength ?? undefined,
        canStream: vector.canStream,
      })
    ).toBe(vector.streams);
  });
});
