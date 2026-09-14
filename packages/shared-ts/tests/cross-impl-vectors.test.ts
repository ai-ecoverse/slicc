import { describe, expect, it } from 'vitest';
import { isTextRequestContentType } from '../src/content-type.js';
import { unmaskFormBody } from '../src/form-body-unmask.js';
import { isSingleLineSecretValue, multilineSecretValueError } from '../src/secret-env-schema.js';
import { mask } from '../src/secret-masking.js';
import { type FetchProxySecretSource, SecretsPipeline } from '../src/secrets-pipeline.js';

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

  it('pins the rejection message both servers return', () => {
    expect(multilineSecretValueError('PEM_KEY')).toBe(
      'Secret "PEM_KEY" value cannot contain newlines; the secret store is line-oriented and would truncate it to the first line'
    );
  });
});
