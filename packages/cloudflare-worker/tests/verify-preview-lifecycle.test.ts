import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DAY_SECONDS,
  MAX_LIVE_OBJECT_DAYS,
  main,
  PREVIEW_PREFIX,
  verifyPreviewLifecycle,
  verifyRules,
} from '../scripts/verify-preview-lifecycle.mjs';
import { MAX_PREVIEW_TTL_MS, PREVIEW_ARCHIVE_PREFIX } from '../src/persistent-preview-storage.js';

const bucket = 'sliccy-now-basic-storage';
const env = { CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_API_TOKEN: 'fake-token' };
const script = 'packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs';
const rule = (days = 90, prefix = 'previews/', enabled = true) => ({
  id: 'preview-retention',
  enabled,
  conditions: { prefix },
  deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * DAY_SECONDS } },
});
const response = (rules = [rule()]) => Response.json({ success: true, result: { rules } });

describe('preview lifecycle prerequisite', () => {
  it('pins the horizon/prefix to runtime retention and the bucket to all four bindings', () => {
    expect(PREVIEW_PREFIX).toBe(PREVIEW_ARCHIVE_PREFIX);
    expect(MAX_LIVE_OBJECT_DAYS * DAY_SECONDS * 1000).toBe(2 * MAX_PREVIEW_TTL_MS);
    for (const file of ['wrangler.jsonc', 'wrangler-preview.jsonc']) {
      const config = readFileSync(`packages/cloudflare-worker/${file}`, 'utf8');
      const bindings = [
        ...config.matchAll(/"binding": "PREVIEW_STORAGE", "bucket_name": "([^"]+)"/g),
      ];
      expect(bindings).toHaveLength(2);
      expect(bindings.map((match) => match[1])).toEqual([bucket, bucket]);
    }
  });

  it.each([61, 75, 90])(
    'accepts an enabled scoped age of %s days without changing any rule',
    (days) => {
      const result = { rules: [rule(days), rule(14, 'assets/'), rule(1, '', false)] };
      const before = structuredClone(result);
      verifyRules(result);
      verifyRules(result);
      expect(result).toEqual(before);
    }
  );

  it.each([0, 14, 45, 60, 91, Infinity, NaN])('rejects unsafe/missing horizon %s', (days) => {
    expect(() => verifyRules({ rules: [rule(days)] })).toThrow();
  });

  it('accepts the live API default multipart rule with omitted prefix without mutating it', () => {
    const result = {
      rules: [
        {
          id: 'Default Multipart Abort Rule',
          enabled: true,
          conditions: {},
          abortMultipartUploadsTransition: {
            condition: { type: 'Age', maxAge: 7 * DAY_SECONDS },
          },
        },
        rule(),
      ],
    };
    const before = structuredClone(result);
    verifyRules(result);
    expect(result).toEqual(before);
  });

  it('treats omitted prefix as bucket-wide for object expiration safety', () => {
    expect(() => verifyRules({ rules: [rule(), { ...rule(14), conditions: {} }] })).toThrow(
      'Conflicting'
    );
    expect(() => verifyRules({ rules: [{ ...rule(), conditions: {} }] })).toThrow('Missing');
  });

  it.each(['', 'pre', 'previews/', 'previews/one/'])(
    'rejects earlier overlapping expiration %s',
    (prefix) => {
      expect(() => verifyRules({ rules: [rule(), rule(14, prefix)] })).toThrow('Conflicting');
    }
  );

  it('does not count disabled, partial coverage, broad or wrong-prefix rules as the scoped backstop', () => {
    for (const rules of [
      [],
      [rule(90, 'previews/', false)],
      [rule(90, 'previews/one/')],
      [rule(90, '')],
      [rule(90, 'preview/')],
    ]) {
      expect(() => verifyRules({ rules })).toThrow('Missing');
    }
  });

  it('rejects date expiration and malformed API schema, even alongside a valid rule', () => {
    const dateRule = {
      ...rule(),
      deleteObjectsTransition: { condition: { type: 'Date', date: '2100-01-01' } },
    };
    for (const invalid of [
      dateRule,
      null,
      {},
      { ...rule(), conditions: { prefix: null } },
      { ...rule(), deleteObjectsTransition: {} },
    ]) {
      expect(() => verifyRules({ rules: [rule(), invalid] })).toThrow();
    }
    for (const result of [null, {}, { rules: {} }]) {
      expect(() => verifyRules(result)).toThrow('Malformed');
    }
  });

  it('uses only bounded authenticated GETs, repeatedly and without mutation', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => response());
    await verifyPreviewLifecycle(bucket, { env, fetchImpl });
    await verifyPreviewLifecycle(bucket, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/fake-account/r2/buckets/${bucket}/lifecycle`
      );
      expect(options).toEqual({
        method: 'GET',
        headers: { Authorization: 'Bearer fake-token' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
    }
  });

  it('fails closed on HTTP, auth, API, JSON and network failures without echoing secrets', async () => {
    for (const fetchImpl of [
      vi.fn().mockImplementation(() => new Response('fake-token', { status: 403 })),
      vi.fn().mockImplementation(() => Response.json({ success: false, errors: ['fake-token'] })),
      vi.fn().mockImplementation(() => new Response('fake-token')),
      vi.fn().mockRejectedValue(new Error('fake-token')),
      vi.fn().mockImplementation(() => response([])),
    ]) {
      const sleepImpl = vi.fn().mockResolvedValue(undefined);
      await expect(verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl })).rejects.toThrow();
      try {
        await verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl });
      } catch (error) {
        expect(String(error)).not.toContain('fake-token');
      }
    }
  });

  it('bounds an unsettled request to 30 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        })
    );
    // AbortSignal.timeout uses native timers, so inject the abort rather than
    // sleeping in the suite; assert the production duration independently.
    const controller = new AbortController();
    timeout.mockReturnValue(controller.signal);
    try {
      fetchImpl
        .mockImplementationOnce(
          (_url, options) =>
            new Promise<Response>((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(options.signal.reason));
            })
        )
        .mockResolvedValue(response());
      const check = verifyPreviewLifecycle(bucket, {
        env,
        fetchImpl,
        sleepImpl: vi.fn().mockResolvedValue(undefined),
      });
      expect(timeout).toHaveBeenCalledWith(30_000);
      controller.abort();
      await check;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });

  it('rejects missing credentials and unknown buckets before any request; help is read-free', async () => {
    const fetchImpl = vi.fn();
    await expect(verifyPreviewLifecycle(bucket, { env: {}, fetchImpl })).rejects.toThrow(
      'required'
    );
    await expect(verifyPreviewLifecycle('slicc-asset-archive', { env, fetchImpl })).rejects.toThrow(
      'Usage'
    );
    await main([bucket, '--help'], { env, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('CLI exits nonzero with operator instructions when credentials are absent', () => {
    const result = spawnSync(process.execPath, [script, bucket], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Provision R2 Prerequisites');
  });

  it.each(['ci.yml', 'worker.yml', 'worker-staging.yml'])(
    'gates %s before uploads/deploy with no continue-on-error',
    (file) => {
      const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
      const gate = workflow.indexOf(`node ${script} ${bucket}`);
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(workflow.indexOf('command: deploy'));
      for (const mutation of workflow.matchAll(/command: deploy|^\s+secrets: \|/gm)) {
        expect(gate).toBeLessThan(mutation.index);
      }
      const step = workflow.slice(
        workflow.lastIndexOf('- name:', gate),
        workflow.indexOf('- name:', gate)
      );
      expect(step).not.toContain('continue-on-error');
      expect(step).toContain('upload-assets-to-r2.mjs');
    }
  );

  it.each([429, 500, 502, 503, 504])('retries HTTP %s with bounded backoff', async (status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('fake-token', { status }))
      .mockResolvedValueOnce(new Response('fake-token', { status }))
      .mockImplementation(() => response());
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    await verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls).toEqual([[1000], [2000]]);
    expect(new Set(fetchImpl.mock.calls.map((call) => call[1].signal)).size).toBe(3);
  });

  it.each([401, 403, 404])('does not retry permanent HTTP %s failures', async (status) => {
    const fetchImpl = vi.fn().mockImplementation(() => new Response('fake-token', { status }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const check = verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl });
    await expect(check).rejects.toThrow(`HTTP ${status}`);
    if (status !== 404) await expect(check).rejects.toThrow('Workers R2 Storage');
    await expect(check).rejects.not.toThrow('fake-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('retries response-body transport failures but stops immediately if the retry is unauthorized', async () => {
    const brokenBody = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('fake-token'));
        },
      })
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(brokenBody)
      .mockResolvedValueOnce(new Response('fake-token', { status: 403 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const check = verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl });
    await expect(check).rejects.toThrow('HTTP 403');
    await expect(check).rejects.not.toThrow('fake-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl.mock.calls).toEqual([[1000]]);
  });

  it('does not retry policy, schema, API or malformed JSON failures', async () => {
    for (const makeResponse of [
      () => response([]),
      () => response([rule(14)]),
      () => Response.json({ success: true, result: {} }),
      () => Response.json({ success: false, errors: ['fake-token'] }),
      () => new Response('fake-token'),
    ]) {
      const fetchImpl = vi.fn().mockImplementation(makeResponse);
      const sleepImpl = vi.fn().mockResolvedValue(undefined);
      await expect(verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleepImpl).not.toHaveBeenCalled();
    }
  });

  it.each(['network', 'HTTP 429', 'HTTP 503'])(
    'reports sanitized exhausted %s failures',
    async (kind) => {
      const fetchImpl =
        kind === 'network'
          ? vi.fn().mockRejectedValue(new Error('fake-token'))
          : vi
              .fn()
              .mockImplementation(
                () => new Response('fake-token', { status: Number(kind.slice(5)) })
              );
      const sleepImpl = vi.fn().mockResolvedValue(undefined);
      const check = verifyPreviewLifecycle(bucket, { env, fetchImpl, sleepImpl });
      await expect(check).rejects.toThrow('transient failure exhausted after 3 attempts');
      await expect(check).rejects.toThrow('check Cloudflare status/network and rerun');
      await expect(check).rejects.not.toThrow('fake-token');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleepImpl.mock.calls).toEqual([[1000], [2000]]);
    }
  );

  it('gates production release after skip/archival and before all secret mutations and deploys', () => {
    const release = readFileSync('packages/cloudflare-worker/scripts/publish-worker.sh', 'utf8');
    const gate = release.indexOf(`node ${script} ${bucket}`);
    expect(gate).toBeGreaterThan(release.indexOf('set -euo pipefail'));
    expect(gate).toBeGreaterThan(release.indexOf('exit 0', release.indexOf('WORKER_GATE=')));
    expect(release.slice(0, gate).match(/^\s*archive_assets$/gm)).toHaveLength(2);
    expect(gate).toBeLessThan(release.indexOf('npx wrangler secret put'));
    for (const match of release.matchAll(/^deploy_with_retry "(?:hub|preview)"/gm)) {
      expect(gate).toBeLessThan(match.index);
    }
  });
});
