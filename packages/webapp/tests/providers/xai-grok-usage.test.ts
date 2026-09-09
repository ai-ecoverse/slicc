import { describe, expect, it, vi } from 'vitest';
import {
  fetchXaiGrokUsage,
  parseXaiUsage,
  XAI_USAGE_URL,
  type XaiUsageFetch,
} from '../../src/providers/xai-grok-usage.js';

/**
 * The real `?format=credits` body, captured from a live logged-in account and
 * redacted of nothing (it carries no identity — no user id, no email, no
 * token). Kept verbatim so the parser is pinned against the wire shape rather
 * than against our idea of it: camelCase names, the enum spelled out in full,
 * protobuf `Cent` rendered as `{val}`, and 6-digit fractional seconds.
 */
const LIVE_BODY = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-09-04T19:03:46.999237+00:00',
      end: '2026-09-11T19:03:46.999237+00:00',
    },
    creditUsagePercent: 23.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokBuild', usagePercent: 23.0 }, { product: 'GrokChat' }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
    billingPeriodStart: '2026-09-04T19:03:46.999237+00:00',
    billingPeriodEnd: '2026-09-11T19:03:46.999237+00:00',
  },
};

function respond(status: number, body: unknown = {}): XaiUsageFetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
}

describe('parseXaiUsage', () => {
  it('reads the live credits body into a weekly window', () => {
    expect(parseXaiUsage(LIVE_BODY)).toEqual({
      percent: 23,
      status: 'ok',
      window: 'weekly',
      resetsAt: '2026-09-11T19:03:46.999237+00:00',
    });
  });

  it('keeps the reset instant parseable despite 6-digit fractional seconds', () => {
    // The proxy emits microseconds and a `+00:00` offset; if `Date.parse`
    // choked on either, the window would silently lose its reset line.
    const window = parseXaiUsage(LIVE_BODY);
    expect(Number.isFinite(Date.parse(window?.resetsAt ?? ''))).toBe(true);
  });

  it('names an unknown period type instead of rejecting the window', () => {
    // A future USAGE_PERIOD_TYPE_DAILY must read without a code change.
    const daily = {
      config: { creditUsagePercent: 4, currentPeriod: { type: 'USAGE_PERIOD_TYPE_DAILY' } },
    };
    expect(parseXaiUsage(daily)).toMatchObject({ window: 'daily' });
  });

  it('falls back to `billing` for a missing, unspecified or non-string type', () => {
    for (const currentPeriod of [{}, { type: 'USAGE_PERIOD_TYPE_UNSPECIFIED' }, { type: 7 }]) {
      expect(parseXaiUsage({ config: { creditUsagePercent: 1, currentPeriod } })).toMatchObject({
        window: 'billing',
      });
    }
  });

  it('falls back to billingPeriodEnd when the period block is absent', () => {
    const window = parseXaiUsage({
      config: { creditUsagePercent: 5, billingPeriodEnd: '2026-09-11T19:03:46Z' },
    });
    expect(window).toMatchObject({ resetsAt: '2026-09-11T19:03:46Z', window: 'billing' });
  });

  it('omits resetsAt entirely rather than reporting an unparseable date', () => {
    const window = parseXaiUsage({
      config: { creditUsagePercent: 5, currentPeriod: { end: 'not-a-date' } },
    });
    expect(window).not.toHaveProperty('resetsAt');
  });

  it('tolerates an unwrapped body without the `config` envelope', () => {
    expect(parseXaiUsage({ creditUsagePercent: 12 })).toMatchObject({ percent: 12 });
  });

  it('reports NO WINDOW rather than 0% when the percent is missing or unusable', () => {
    // "We don't know" and "you have your whole week left" must not look alike.
    expect(parseXaiUsage({ config: {} })).toBeNull();
    expect(parseXaiUsage({ config: { creditUsagePercent: null } })).toBeNull();
    expect(parseXaiUsage({ config: { creditUsagePercent: '23' } })).toBeNull();
    expect(parseXaiUsage({ config: { creditUsagePercent: Number.NaN } })).toBeNull();
    expect(parseXaiUsage({ config: { creditUsagePercent: Number.POSITIVE_INFINITY } })).toBeNull();
    expect(parseXaiUsage(null)).toBeNull();
    expect(parseXaiUsage('nope')).toBeNull();
  });

  it('clamps a nonsensical percent instead of rendering it', () => {
    expect(parseXaiUsage({ config: { creditUsagePercent: -5 } })).toMatchObject({ percent: 0 });
    expect(parseXaiUsage({ config: { creditUsagePercent: 1e12 } })).toMatchObject({
      percent: 1000,
    });
  });

  it('lets a genuine overage through intact', () => {
    // 104% is a fact about a burnt window, not a parse error.
    expect(parseXaiUsage({ config: { creditUsagePercent: 104 } })).toMatchObject({ percent: 104 });
  });
});

describe('fetchXaiGrokUsage', () => {
  it('sends ONE GET to the credits route carrying only the bearer token', async () => {
    // The minimum viable request, established by removing headers until it
    // broke: no x-userid, no x-grok-client-*, no X-XAI-Token-Auth.
    const fetchImpl = respond(200, LIVE_BODY);
    const window = await fetchXaiGrokUsage('tok', fetchImpl);

    expect(window).toMatchObject({ percent: 23, window: 'weekly' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      XAI_USAGE_URL,
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } })
    );
  });

  it('asks for the credits view, not the monthly one', () => {
    // Dropping `?format=credits` silently returns a different RPC's shape.
    expect(XAI_USAGE_URL).toContain('format=credits');
    expect(XAI_USAGE_URL).toContain('cli-chat-proxy.grok.com');
  });

  it('reports NO WINDOW when the undocumented route has moved', async () => {
    // 404/501 is the route answering, not failing: the caller writes the
    // provider off for half an hour rather than retrying in five minutes.
    await expect(fetchXaiGrokUsage('t', respond(404))).resolves.toBeNull();
    await expect(fetchXaiGrokUsage('t', respond(501))).resolves.toBeNull();
  });

  it('says RE-LOGIN on 401/403 rather than crashing a render path', async () => {
    await expect(fetchXaiGrokUsage('t', respond(401))).rejects.toThrow(/re-login required \(401\)/);
    await expect(fetchXaiGrokUsage('t', respond(403))).rejects.toThrow(/re-login required \(403\)/);
  });

  it('THROWS on a broken call so the retry clock stays short', async () => {
    await expect(fetchXaiGrokUsage('t', respond(500))).rejects.toThrow('500');
    await expect(fetchXaiGrokUsage('t', respond(503))).rejects.toThrow('503');
  });

  it('treats a 200 that is not JSON as no window, not an outage', async () => {
    // A login wall or interstitial answers 200 with HTML.
    await expect(fetchXaiGrokUsage('t', respond(200, '<html>sign in</html>'))).resolves.toBeNull();
  });

  it('refuses to parse an oversized body', async () => {
    // Never hand an unbounded third-party string to JSON.parse.
    const huge = `{"config":{"creditUsagePercent":23,"pad":"${'x'.repeat(70 * 1024)}"}}`;
    await expect(fetchXaiGrokUsage('t', respond(200, huge))).resolves.toBeNull();
  });

  it('aborts a stalled proxy instead of hanging the poll', async () => {
    const fetchImpl: XaiUsageFetch = (_input, init) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(fetchXaiGrokUsage('t', fetchImpl, { timeoutMs: 1 })).rejects.toThrow('aborted');
  });
});
