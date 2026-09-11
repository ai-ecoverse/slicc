// packages/webapp/tests/e2e/roving-tray-webhook.test.ts
/**
 * Roving-tray webhook scenario (issue #2812 groundwork) — the #1957 incident
 * as a repeatable test, against the harness's REAL `wrangler dev` tray hub.
 *
 * A webhook URL bakes the tray id into its address. This scenario walks one
 * URL through a full rove and pins each stop:
 *
 *   1. leader mints tray A, `webhook create` hands out URL_A — an external
 *      sender (this test process) delivers and the event reaches the cone;
 *   2. `host reset` roves the leader to tray B. The reset leaves NO
 *      forwarding address (`pageLeaderTray.reset()` never supersedes), so
 *      URL_A now answers 410 and the delivery is silently lost — while from
 *      inside nothing looks broken (the registration lives in IndexedDB and
 *      survived);
 *   3. the test performs the supersede call the stale-session recovery path
 *      would have made (`notifyTraySuperseded` in `tray-leader.ts`: POST
 *      /api/tray/A/supersede, Bearer = A's controller token) — after which a
 *      sender that follows POST redirects recovers end to end, and a manual
 *      probe shows the cost #2812 wants gone: the replacement's webhook
 *      capability (a secret) rides in `Location`;
 *   4. the old join URL redirects the same way.
 *
 * The DO-level matrix (`packages/cloudflare-worker/tests/roving-tray.test.ts`)
 * pins the per-surface behavior exhaustively; this spec proves the one
 * full-stack path — real leader, real Durable Object, real HTTP sender —
 * including the client-side half (the webhook registration outliving the
 * tray) that no worker-only test can see.
 */

import type { Page } from '@playwright/test';
import rovingFixture from './fake-llm/fixtures/roving-tray-webhook.json' with { type: 'json' };
import { resetFakeLlm } from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { LEADER_ORIGIN } from './playwright.config.js';
import {
  bootMultiConeLeader,
  CONE_TEST_TIMEOUT_MS,
  execInTerminal,
  leaderJoinUrl,
  thread,
} from './two-instance-helpers.js';

/** The slice of `LeaderTraySession` this scenario reads from the status shim. */
interface SessionSnapshot {
  trayId: string;
  joinUrl: string;
  webhookUrl: string;
  controllerUrl: string;
}

/**
 * The leader's current tray session, from the `slicc.leaderTrayStatus`
 * localStorage shim the page keeps current (the same source `leaderJoinUrl`
 * polls — the manager runs in the page realm and the test does not).
 */
async function leaderSession(page: Page, timeoutMs = 45_000): Promise<SessionSnapshot> {
  const handle = await page.waitForFunction(
    () => {
      try {
        const raw = localStorage.getItem('slicc.leaderTrayStatus');
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          state?: string;
          session?: SessionSnapshot | null;
        };
        return parsed.state === 'leader' && parsed.session?.trayId ? parsed.session : null;
      } catch {
        return null;
      }
    },
    null,
    { timeout: timeoutMs }
  );
  return (await handle.jsonValue()) as SessionSnapshot;
}

/** POST one webhook delivery the way an external service would. */
async function deliver(url: string, marker: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'render-finished', marker }),
  });
}

test.describe('roving tray — webhook URLs across a reset', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test('a reset strands the cached webhook URL; supersede + 308 recovers it', async ({ page }) => {
    test.setTimeout(CONE_TEST_TIMEOUT_MS);
    await bootMultiConeLeader(page, { fixture: rovingFixture, tray: true });
    await leaderJoinUrl(page); // enables sync and waits for the leader role
    const before = await leaderSession(page);

    // ── 1. Register a webhook on tray A and prove the URL works. ────────
    const created = await execInTerminal(page, 'webhook create --name rove-hook');
    expect(created.exitCode).toBe(0);
    const hookUrl = /^URL: (\S+)$/m.exec(created.stdout)?.[1];
    expect(hookUrl, `webhook create output:\n${created.stdout}`).toBeTruthy();
    // The address bakes in the tray INSTANCE — the whole problem.
    expect(hookUrl).toContain(before.trayId);

    const first = await deliver(hookUrl!, 'marker-one');
    expect(first.status).toBe(202);
    expect(((await first.json()) as { ok?: boolean }).ok).toBe(true);
    await expect(thread(page)).toContainText('Rove event one received.', { timeout: 90_000 });

    // ── 2. Rove: `host reset` mints a fresh tray and leaves NO forwarding
    // address (reset() never calls supersede — unlike the stale-session
    // recovery path). The registration itself survives in IndexedDB, so from
    // inside nothing looks broken; only the cached URL string is now dead.
    const reset = await execInTerminal(page, 'host reset');
    expect(reset.exitCode).toBe(0);
    await expect
      .poll(async () => (await leaderSession(page)).trayId, { timeout: 60_000 })
      .not.toBe(before.trayId);
    const after = await leaderSession(page);

    // The sender's cached URL now answers 410 and the event is GONE — the
    // #1957 loss, reproduced. (Poll: the old DO marks the leader disconnected
    // when workerd delivers the socket close, which can lag the reset by a
    // beat; until then the relay may still answer 202 into the dead socket.)
    await expect
      .poll(async () => (await deliver(hookUrl!, 'marker-lost')).status, { timeout: 30_000 })
      .toBe(410);

    // ── 3. The missing half of the rove: the supersede call the recovery
    // path would have made. Same endpoint, same auth, same body as
    // `notifyTraySuperseded` (webapp `tray-leader.ts`).
    const controllerToken = new URL(before.controllerUrl).pathname.split('/').pop()!;
    const superseded = await fetch(`${LEADER_ORIGIN}/api/tray/${before.trayId}/supersede`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controllerToken}`,
      },
      body: JSON.stringify({ joinUrl: after.joinUrl, webhookUrl: after.webhookUrl }),
    });
    expect(superseded.status).toBe(200);

    // A manual probe sees the 308 — and the cost #2812 names: the NEW tray's
    // webhook capability (a secret) rides in `Location` to whoever holds the
    // OLD URL.
    const probe = await fetch(hookUrl!, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'probe' }),
    });
    expect(probe.status).toBe(308);
    const location = probe.headers.get('location');
    expect(location).toBeTruthy();
    expect(location!.startsWith(`${after.webhookUrl}/`)).toBe(true);

    // An external sender that follows POST redirects (fetch's default — 308
    // preserves method and body) recovers end to end: old URL, new tray, same
    // registration, event in the cone.
    const second = await deliver(hookUrl!, 'marker-two');
    expect(second.status).toBe(202);
    expect(((await second.json()) as { ok?: boolean }).ok).toBe(true);
    await expect(thread(page)).toContainText('Rove event two received.', { timeout: 90_000 });

    // ── 4. The join surface redirects the same way. `?json=true` keeps the
    // GET an API probe (a bare GET would land on the worker's SPA fallback)
    // and is carried onto `Location` so a platform-followed hop stays one too.
    const joinProbe = await fetch(`${before.joinUrl}?json=true`, { redirect: 'manual' });
    expect(joinProbe.status).toBe(308);
    expect(joinProbe.headers.get('location')).toBe(`${after.joinUrl}?json=true`);
  });
});
