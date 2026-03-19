import { describe, expect, it } from 'vitest';

import { encodeCDPMessage, parseCDPResponse } from './install-extension.js';

describe('encodeCDPMessage', () => {
  it('encodes method + params as null-terminated JSON buffer', () => {
    const result = encodeCDPMessage(1, 'Extensions.loadUnpacked', {
      path: '/absolute/path/to/dist/extension',
    });

    const text = result.toString('utf-8');
    expect(text.endsWith('\0')).toBe(true);

    const json = JSON.parse(text.slice(0, -1));
    expect(json).toEqual({
      id: 1,
      method: 'Extensions.loadUnpacked',
      params: {
        path: '/absolute/path/to/dist/extension',
      },
    });
  });

  it('encodes method without params (empty params object)', () => {
    const result = encodeCDPMessage(2, 'Browser.getVersion', {});

    const text = result.toString('utf-8');
    expect(text.endsWith('\0')).toBe(true);

    const json = JSON.parse(text.slice(0, -1));
    expect(json).toEqual({
      id: 2,
      method: 'Browser.getVersion',
      params: {},
    });
  });

  it('produces a buffer with correct encoding', () => {
    const result = encodeCDPMessage(1, 'Test.method', { foo: 'bar' });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result[result.length - 1]).toBe(0); // null byte at end
  });
});

describe('parseCDPResponse', () => {
  it('parses successful response with extension ID', () => {
    const response = Buffer.from(
      '{"id": 1, "result": {"id": "extension-id-string"}}\0',
      'utf-8',
    );

    const result = parseCDPResponse(response);

    expect(result).toEqual({
      id: 1,
      result: {
        id: 'extension-id-string',
      },
    });
  });

  it('parses error response', () => {
    const response = Buffer.from(
      '{"id": 1, "error": {"code": -32600, "message": "Invalid request"}}\0',
      'utf-8',
    );

    const result = parseCDPResponse(response);

    expect(result).toEqual({
      id: 1,
      error: {
        code: -32600,
        message: 'Invalid request',
      },
    });
  });

  it('returns null for invalid JSON', () => {
    const response = Buffer.from('invalid json\0', 'utf-8');

    const result = parseCDPResponse(response);

    expect(result).toBe(null);
  });

  it('removes trailing null byte before parsing', () => {
    const response = Buffer.from('{"id": 1, "result": {}}\0', 'utf-8');

    const result = parseCDPResponse(response);

    expect(result).toEqual({
      id: 1,
      result: {},
    });
  });

  it('handles multiple null bytes at end (takes all but last)', () => {
    const response = Buffer.from('{"id": 1, "result": {}}\0\0', 'utf-8');

    const result = parseCDPResponse(response);

    // Should still parse correctly, trimming trailing nulls
    expect(result).toEqual({
      id: 1,
      result: {},
    });
  });
});
