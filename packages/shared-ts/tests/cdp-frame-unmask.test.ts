import { beforeEach, describe, expect, it } from 'vitest';
import { type CdpFrame, unmaskCdpFrame } from '../src/cdp-frame-unmask.js';
import { type FetchProxySecretSource, SecretsPipeline } from '../src/secrets-pipeline.js';

function source(
  entries: { name: string; value: string; domains: string[] }[]
): FetchProxySecretSource {
  return {
    get: async (name) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  };
}

describe('unmaskCdpFrame', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([{ name: 'API_KEY', value: 'sk-realValue123', domains: ['example.com'] }]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('API_KEY', 'sk-realValue123');
  });

  it('Runtime.evaluate: in-domain unmask replaces expression', () => {
    const frame: CdpFrame = {
      id: 1,
      sessionId: 'S1',
      method: 'Runtime.evaluate',
      params: { expression: `submit(${masked})`, returnByValue: true },
    };
    const result = unmaskCdpFrame(frame, 'example.com', pipeline);
    expect(result.changed).toBe(true);
    const params = result.frame.params as { expression: string; returnByValue: boolean };
    expect(params.expression).toBe('submit(sk-realValue123)');
    expect(params.returnByValue).toBe(true);
    expect(result.frame.id).toBe(1);
    expect(result.frame.sessionId).toBe('S1');
    expect(frame.params).toEqual({ expression: `submit(${masked})`, returnByValue: true });
  });

  it('Runtime.evaluate: out-of-domain leaves frame untouched (reference equality)', () => {
    const frame: CdpFrame = {
      method: 'Runtime.evaluate',
      params: { expression: `submit(${masked})` },
    };
    const result = unmaskCdpFrame(frame, 'evil.example.org', pipeline);
    expect(result.changed).toBe(false);
    expect(result.frame).toBe(frame);
  });

  it('Input.insertText: in-domain unmask replaces text', () => {
    const frame: CdpFrame = {
      method: 'Input.insertText',
      params: { text: masked },
    };
    const result = unmaskCdpFrame(frame, 'example.com', pipeline);
    expect(result.changed).toBe(true);
    expect((result.frame.params as { text: string }).text).toBe('sk-realValue123');
  });

  it('Input.insertText: out-of-domain passthrough untouched', () => {
    const frame: CdpFrame = {
      method: 'Input.insertText',
      params: { text: masked },
    };
    const result = unmaskCdpFrame(frame, 'evil.example.org', pipeline);
    expect(result.changed).toBe(false);
    expect(result.frame).toBe(frame);
  });

  it('Runtime.callFunctionOn: only string arguments[].value entries unmask; non-strings pass through', () => {
    const frame: CdpFrame = {
      method: 'Runtime.callFunctionOn',
      params: {
        functionDeclaration: 'function(v){this.value=v}',
        arguments: [
          { value: masked },
          { value: 42 },
          { objectId: 'obj-1' },
          { value: { nested: masked } },
          { value: `prefix ${masked} suffix` },
        ],
      },
    };
    const result = unmaskCdpFrame(frame, 'example.com', pipeline);
    expect(result.changed).toBe(true);
    const args = (result.frame.params as { arguments: unknown[] }).arguments;
    expect(args[0]).toEqual({ value: 'sk-realValue123' });
    expect(args[1]).toEqual({ value: 42 });
    expect(args[2]).toEqual({ objectId: 'obj-1' });
    expect(args[3]).toEqual({ value: { nested: masked } });
    expect(args[4]).toEqual({ value: 'prefix sk-realValue123 suffix' });
  });

  it('Runtime.callFunctionOn: out-of-domain leaves frame untouched', () => {
    const frame: CdpFrame = {
      method: 'Runtime.callFunctionOn',
      params: { arguments: [{ value: masked }] },
    };
    const result = unmaskCdpFrame(frame, 'evil.example.org', pipeline);
    expect(result.changed).toBe(false);
    expect(result.frame).toBe(frame);
  });

  it('Runtime.callFunctionOn: arguments without any masked value is unchanged', () => {
    const frame: CdpFrame = {
      method: 'Runtime.callFunctionOn',
      params: { arguments: [{ value: 'plain' }, { value: 7 }] },
    };
    const result = unmaskCdpFrame(frame, 'example.com', pipeline);
    expect(result.changed).toBe(false);
    expect(result.frame).toBe(frame);
  });

  it('no-secrets pipeline: helper is a no-op', async () => {
    const empty = new SecretsPipeline({ sessionId: 'S', source: source([]) });
    await empty.reload();
    const frame: CdpFrame = {
      method: 'Runtime.evaluate',
      params: { expression: 'anything' },
    };
    const result = unmaskCdpFrame(frame, 'example.com', empty);
    expect(result.changed).toBe(false);
    expect(result.frame).toBe(frame);
  });

  it('unrelated CDP methods are passed through untouched', () => {
    const frame: CdpFrame = {
      method: 'Input.dispatchKeyEvent',
      params: { type: 'char', text: masked },
    };
    const result = unmaskCdpFrame(frame, 'example.com', pipeline);
    expect(result.changed).toBe(false);
    expect(result.frame).toBe(frame);
  });

  it('malformed frames (missing params / non-object params) pass through', () => {
    const f1: CdpFrame = { method: 'Runtime.evaluate' };
    expect(unmaskCdpFrame(f1, 'example.com', pipeline)).toEqual({ frame: f1, changed: false });
    const f2: CdpFrame = { method: 'Runtime.evaluate', params: 'oops' as unknown };
    expect(unmaskCdpFrame(f2, 'example.com', pipeline)).toEqual({ frame: f2, changed: false });
    const f3: CdpFrame = { method: 'Runtime.evaluate', params: { expression: 123 as unknown } };
    expect(unmaskCdpFrame(f3, 'example.com', pipeline)).toEqual({ frame: f3, changed: false });
    const f4: CdpFrame = {
      method: 'Runtime.callFunctionOn',
      params: { arguments: 'not-an-array' as unknown },
    };
    expect(unmaskCdpFrame(f4, 'example.com', pipeline)).toEqual({ frame: f4, changed: false });
  });
});
