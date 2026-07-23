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

  it('preserves a caller-provided binary Content-Type case-insensitively', async () => {
    const serialized = await serializeRequestInit(
      {
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(expectedBytes),
      },
      '/upload'
    );

    expect(serialized?.headers).toEqual({ 'content-type': 'image/png' });
  });

  it('leaves string and URLSearchParams bodies unchanged', async () => {
    const text = await serializeRequestInit({ body: 'hello\u0000world' }, '/text');
    const params = new URLSearchParams({ grant_type: 'client_credentials', scope: 'a b' });
    const form = await serializeRequestInit({ body: params }, '/token');

    expect(text?.body).toBe('hello\u0000world');
    expect(text?.headers).toEqual({});
    expect(form?.body).toBe(params.toString());
    expect(form?.headers).toEqual({});
  });

  it('rejects unsupported FormData and ReadableStream bodies explicitly', async () => {
    await expect(serializeRequestInit({ body: new FormData() }, '/form')).rejects.toThrow(
      'node fetch shim: FormData request bodies are not supported (post raw application/x-www-form-urlencoded with URLSearchParams instead)'
    );
    await expect(
      serializeRequestInit({ body: new ReadableStream<Uint8Array>() }, '/stream')
    ).rejects.toThrow(
      'node fetch shim: ReadableStream request bodies are not supported (collect into a Uint8Array or string before calling fetch)'
    );
  });
});
