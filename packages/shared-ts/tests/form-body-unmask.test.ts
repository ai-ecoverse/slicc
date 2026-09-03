import { beforeEach, describe, expect, it } from 'vitest';
import { unmaskFormBody } from '../src/form-body-unmask.js';
import { mask } from '../src/secret-masking.js';
import { type FetchProxySecretSource, SecretsPipeline } from '../src/secrets-pipeline.js';

const SESSION = 'session-form-unmask';
// A base64-shaped secret: `+`, `/` and `=` are all reserved in a form body, so
// a naive substring splice would corrupt the request.
const REAL = 'ab+cd/ef=gh&ij kl%mn';

function source(entries: { name: string; value: string; domains: string[] }[]) {
  return {
    get: async (name: string) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  } satisfies FetchProxySecretSource;
}

let pipeline: SecretsPipeline;
let masked: string;

beforeEach(async () => {
  pipeline = new SecretsPipeline({
    sessionId: SESSION,
    source: source([{ name: 'FORM_SECRET', value: REAL, domains: ['api.example.com'] }]),
  });
  await pipeline.reload();
  masked = await mask(SESSION, 'FORM_SECRET', REAL);
});

describe('unmaskFormBody', () => {
  it('percent-encodes the real value so the field survives the round-trip', () => {
    const { text } = unmaskFormBody(
      pipeline,
      `token=${masked}&grant_type=client_credentials`,
      'api.example.com'
    );
    // The upstream parse must yield the real secret exactly, and the field count
    // must not change — `&`/`=` inside the secret must not split the body.
    const parsed = new URLSearchParams(text);
    expect(parsed.get('token')).toBe(REAL);
    expect(parsed.get('grant_type')).toBe('client_credentials');
    expect([...parsed.keys()]).toEqual(['token', 'grant_type']);
    expect(text).not.toContain(masked);
  });

  it('does not let a secret inject an extra parameter', () => {
    const { text } = unmaskFormBody(pipeline, `token=${masked}`, 'api.example.com');
    expect([...new URLSearchParams(text).keys()]).toEqual(['token']);
    expect(text).not.toContain('&ij');
  });

  it('leaves untouched fields byte-identical', () => {
    const body = 'a=1&b=hello+world&c=%2Fpath';
    expect(unmaskFormBody(pipeline, body, 'api.example.com').text).toBe(body);
  });

  it('returns the body unchanged when the pipeline holds no secrets', async () => {
    const empty = new SecretsPipeline({ sessionId: SESSION, source: source([]) });
    await empty.reload();
    const body = `token=${masked}`;
    expect(unmaskFormBody(empty, body, 'api.example.com').text).toBe(body);
  });

  it('leaves the masked token in place for an out-of-scope domain', () => {
    const body = `token=${masked}`;
    expect(unmaskFormBody(pipeline, body, 'evil.example.org').text).toBe(body);
  });

  it('unmasks a masked token the client percent-encoded', () => {
    const { text } = unmaskFormBody(
      pipeline,
      `token=${encodeURIComponent(masked)}`,
      'api.example.com'
    );
    expect(new URLSearchParams(text).get('token')).toBe(REAL);
  });

  it('unmasks a keyless single-token body', () => {
    const { text } = unmaskFormBody(pipeline, masked, 'api.example.com');
    expect(decodeURIComponent(text.replace(/\+/g, '%20'))).toBe(REAL);
  });

  it('unmasks every occurrence across multiple fields', () => {
    const { text } = unmaskFormBody(pipeline, `a=${masked}&b=keep&c=${masked}`, 'api.example.com');
    const parsed = new URLSearchParams(text);
    expect(parsed.get('a')).toBe(REAL);
    expect(parsed.get('b')).toBe('keep');
    expect(parsed.get('c')).toBe(REAL);
  });

  it('falls back to a substring replace on a malformed escape rather than dropping the secret', () => {
    // `%zz` is not a valid escape, so the field's encoding is uninterpretable.
    const { text } = unmaskFormBody(pipeline, `token=%zz${masked}`, 'api.example.com');
    expect(text).toContain(REAL);
    expect(text).not.toContain(masked);
  });

  it('skips empty values and an empty body', () => {
    expect(unmaskFormBody(pipeline, '', 'api.example.com').text).toBe('');
    expect(unmaskFormBody(pipeline, 'a=&b=', 'api.example.com').text).toBe('a=&b=');
  });
});
