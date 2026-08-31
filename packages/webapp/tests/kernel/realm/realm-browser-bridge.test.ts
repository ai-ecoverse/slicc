import { describe, expect, it } from 'vitest';
import { serializeRequestInit } from '../../../src/kernel/realm/realm-browser-bridge.js';
import { getFetchBodyBytes } from '../../../src/shell/fetch-body.js';

const expectedBytes = [0x00, 0x7f, 0x80, 0xff, 0x2a];

function bytesBuffer(): ArrayBuffer {
  return new Uint8Array(expectedBytes).buffer;
}

describe('serializeRequestInit', () => {
  const binaryBodies: Array<[string, () => BodyInit]> = [
    ['Uint8Array', () => new Uint8Array(expectedBytes)],
    ['ArrayBuffer', bytesBuffer],
    [
      'ArrayBufferView',
      () => {
        const framed = new Uint8Array([0xaa, ...expectedBytes, 0xbb]);
        return new DataView(framed.buffer, 1, expectedBytes.length);
      },
    ],
    ['Blob', () => new Blob([new Uint8Array(expectedBytes)])],
  ];

  it.each(binaryBodies)('round-trips a %s body through latin1', async (_name, makeBody) => {
    const serialized = await serializeRequestInit({ method: 'post', body: makeBody() }, '/upload');

    expect(serialized?.method).toBe('POST');
    expect(serialized?.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(Array.from(getFetchBodyBytes(serialized?.body as string))).toEqual(expectedBytes);
  });

  it.each([
    ['image/png', 'image/png'],
    ['', 'application/octet-stream'],
  ])('defaults a Blob with type %j to %s', async (type, contentType) => {
    const serialized = await serializeRequestInit(
      { method: 'post', body: new Blob([new Uint8Array(expectedBytes)], { type }) },
      '/upload'
    );

    expect(serialized?.headers).toEqual({ 'Content-Type': contentType });
    expect(Array.from(getFetchBodyBytes(serialized?.body as string))).toEqual(expectedBytes);
  });

  it('preserves a caller-provided Blob Content-Type case-insensitively', async () => {
    const serialized = await serializeRequestInit(
      {
        method: 'post',
        headers: { 'CONTENT-TYPE': 'application/custom' },
        body: new Blob([new Uint8Array(expectedBytes)], { type: 'image/png' }),
      },
      '/upload'
    );

    expect(serialized?.headers).toEqual({ 'CONTENT-TYPE': 'application/custom' });
  });

  it('leaves a string body unchanged', async () => {
    const text = await serializeRequestInit({ method: 'post', body: 'hello\u0000world' }, '/text');

    expect(text?.body).toBe('hello\u0000world');
    expect(text?.headers).toEqual({});
  });

  it('defaults a URLSearchParams body to form-urlencoded', async () => {
    // The host adapter receives only a string and can no longer tell this
    // apart from text/plain, so the default has to be decided here — an OAuth
    // token endpoint rejects the request without it.
    const params = new URLSearchParams({ grant_type: 'client_credentials', scope: 'a b' });
    const form = await serializeRequestInit({ method: 'post', body: params }, '/token');

    expect(form?.body).toBe(params.toString());
    expect(form?.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
  });

  it('lets a caller-provided Content-Type win over the URLSearchParams default', async () => {
    const serialized = await serializeRequestInit(
      { method: 'post', headers: { 'CONTENT-TYPE': 'text/plain' }, body: new URLSearchParams() },
      '/token'
    );

    expect(serialized?.headers).toEqual({ 'CONTENT-TYPE': 'text/plain' });
  });

  it.each([
    [
      'a FormData',
      () => {
        const f = new FormData();
        f.append('a', 'b');
        return f;
      },
    ],
    ['a Blob', () => new Blob([new Uint8Array(expectedBytes)])],
    ['a URLSearchParams', () => new URLSearchParams({ a: 'b' })],
  ])('drops %s body on GET without advertising a Content-Type', async (_name, makeBody) => {
    // GET/HEAD cannot carry a body; the host adapter drops it downstream, so
    // serializing here would leave a Content-Type describing a body that never
    // ships. The direct adapter path sends neither — keep the two in step.
    const serialized = await serializeRequestInit({ method: 'get', body: makeBody() }, '/x');

    expect(serialized?.body).toBeUndefined();
    expect(serialized?.headers).toEqual({});
  });

  it('serializes a FormData body as multipart with a matching boundary', async () => {
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([new Uint8Array(expectedBytes)], { type: 'text/plain' }), 'a.txt');

    const serialized = await serializeRequestInit({ method: 'post', body: form }, '/upload');

    const contentType = serialized?.headers as Record<string, string>;
    expect(contentType['Content-Type']).toMatch(/^multipart\/form-data; boundary=.+/);

    // Reparse with the platform's multipart parser: this proves the header's
    // boundary matches the body's delimiters AND that the high bytes survived
    // the latin1 hop the fetch proxy decodes back to raw bytes.
    const bytes = getFetchBodyBytes(serialized?.body as string) as Uint8Array;
    const parsed = await new Response(bytes as unknown as BodyInit, {
      headers: { 'content-type': contentType['Content-Type'] },
    }).formData();
    expect(parsed.get('purpose')).toBe('assistants');
    const file = parsed.get('file') as File;
    expect(file.name).toBe('a.txt');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(expectedBytes);
  });

  it('leaves a caller-provided multipart Content-Type on a FormData body alone', async () => {
    const form = new FormData();
    form.append('a', 'b');

    const serialized = await serializeRequestInit(
      {
        method: 'post',
        headers: { 'CONTENT-TYPE': 'multipart/form-data; boundary=mine' },
        body: form,
      },
      '/upload'
    );

    expect(serialized?.headers).toEqual({ 'CONTENT-TYPE': 'multipart/form-data; boundary=mine' });
  });

  it('rejects unsupported ReadableStream bodies explicitly', async () => {
    await expect(
      serializeRequestInit({ method: 'post', body: new ReadableStream<Uint8Array>() }, '/stream')
    ).rejects.toThrow(
      'node fetch shim: ReadableStream request bodies are not supported (collect into a Uint8Array or string before calling fetch)'
    );
  });
});
