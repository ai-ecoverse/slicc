import { type FetchProxySecretSource, SecretsPipeline } from '@slicc/shared-ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyCdpUnmask, CDP_CLIENT_FRAME_MAX_BYTES } from '../../src/cdp-proxy/cdp-unmask.js';
import { createCdpSessionUrlTracker } from '../../src/cdp-proxy/session-url-tracker.js';

function source(
  entries: { name: string; value: string; domains: string[] }[]
): FetchProxySecretSource {
  return {
    get: async (name) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  };
}

async function buildPipeline(): Promise<{ pipeline: SecretsPipeline; masked: string }> {
  const pipeline = new SecretsPipeline({
    sessionId: 'session-fixed',
    source: source([{ name: 'API_KEY', value: 'sk-realValue123', domains: ['example.com'] }]),
  });
  await pipeline.reload();
  const masked = await pipeline.maskOne('API_KEY', 'sk-realValue123');
  return { pipeline, masked };
}

describe('applyCdpUnmask', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    ({ pipeline, masked } = await buildPipeline());
  });

  function seededTracker() {
    const tracker = createCdpSessionUrlTracker();
    tracker.observeChromeToClient({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S1',
        targetInfo: { targetId: 'T1', type: 'page', url: 'https://example.com/' },
      },
    });
    return tracker;
  }

  it('unmasks Input.insertText when the session URL is in-domain', () => {
    const tracker = seededTracker();
    const input = JSON.stringify({
      id: 7,
      sessionId: 'S1',
      method: 'Input.insertText',
      params: { text: masked },
    });
    const r = applyCdpUnmask(input, { tracker, pipeline });
    expect(r.changed).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.params.text).toBe('sk-realValue123');
    expect(out.id).toBe(7);
    expect(out.sessionId).toBe('S1');
  });

  it('FAILS CLOSED when sessionId is unknown (no hostname resolvable)', () => {
    const tracker = seededTracker();
    const input = JSON.stringify({
      id: 8,
      sessionId: 'UNKNOWN',
      method: 'Input.insertText',
      params: { text: masked },
    });
    const r = applyCdpUnmask(input, { tracker, pipeline });
    expect(r.changed).toBe(false);
    expect(r.skipped).toBe('no-hostname');
    expect(r.output).toBe(input);
  });

  it('FAILS CLOSED when frame carries no sessionId (browser-level command)', () => {
    const tracker = seededTracker();
    const input = JSON.stringify({
      id: 9,
      method: 'Input.insertText',
      params: { text: masked },
    });
    const r = applyCdpUnmask(input, { tracker, pipeline });
    expect(r.changed).toBe(false);
    expect(r.skipped).toBe('no-hostname');
    expect(r.output).toBe(input);
  });

  it('forwards verbatim when in-domain but no secrets match', () => {
    const tracker = seededTracker();
    const input = JSON.stringify({
      id: 10,
      sessionId: 'S1',
      method: 'Input.insertText',
      params: { text: 'just plain text' },
    });
    const r = applyCdpUnmask(input, { tracker, pipeline });
    expect(r.changed).toBe(false);
    expect(r.output).toBe(input);
  });

  it('forwards verbatim on out-of-domain (domain-mismatch is unmaskBody-internal)', () => {
    const tracker = createCdpSessionUrlTracker();
    tracker.observeChromeToClient({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S1',
        targetInfo: { targetId: 'T1', type: 'page', url: 'https://evil.example.org/' },
      },
    });
    const input = JSON.stringify({
      id: 11,
      sessionId: 'S1',
      method: 'Input.insertText',
      params: { text: masked },
    });
    const r = applyCdpUnmask(input, { tracker, pipeline });
    expect(r.changed).toBe(false);
    expect(r.output).toBe(input);
  });

  it('unmasks Runtime.evaluate and Runtime.callFunctionOn in-domain', () => {
    const tracker = seededTracker();
    const evalInput = JSON.stringify({
      sessionId: 'S1',
      method: 'Runtime.evaluate',
      params: { expression: `submit(${masked})` },
    });
    const evalOut = JSON.parse(applyCdpUnmask(evalInput, { tracker, pipeline }).output);
    expect(evalOut.params.expression).toBe('submit(sk-realValue123)');

    const callInput = JSON.stringify({
      sessionId: 'S1',
      method: 'Runtime.callFunctionOn',
      params: { arguments: [{ value: masked }, { value: 42 }] },
    });
    const callOut = JSON.parse(applyCdpUnmask(callInput, { tracker, pipeline }).output);
    expect(callOut.params.arguments[0].value).toBe('sk-realValue123');
    expect(callOut.params.arguments[1].value).toBe(42);
  });

  it('skips oversized frames without parsing', () => {
    const tracker = seededTracker();
    const big = 'x'.repeat(CDP_CLIENT_FRAME_MAX_BYTES + 1);
    const r = applyCdpUnmask(big, { tracker, pipeline });
    expect(r.skipped).toBe('oversized');
    expect(r.output).toBe(big);
  });

  it('forwards verbatim on JSON parse error', () => {
    const tracker = seededTracker();
    const r = applyCdpUnmask('not-json{', { tracker, pipeline });
    expect(r.skipped).toBe('parse-error');
    expect(r.output).toBe('not-json{');
  });

  it('no-ops when the pipeline has no secrets', async () => {
    const empty = new SecretsPipeline({ sessionId: 's', source: source([]) });
    await empty.reload();
    const tracker = seededTracker();
    const input = JSON.stringify({
      sessionId: 'S1',
      method: 'Input.insertText',
      params: { text: masked },
    });
    const r = applyCdpUnmask(input, { tracker, pipeline: empty });
    expect(r.skipped).toBe('no-secrets');
    expect(r.output).toBe(input);
  });
});
