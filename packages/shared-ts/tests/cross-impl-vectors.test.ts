import { describe, expect, it } from 'vitest';
import { isTextRequestContentType } from '../src/content-type.js';
import { unmaskFormBody } from '../src/form-body-unmask.js';
import { isSingleLineSecretValue, multilineSecretValueError } from '../src/secret-env-schema.js';
import { mask } from '../src/secret-masking.js';
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
