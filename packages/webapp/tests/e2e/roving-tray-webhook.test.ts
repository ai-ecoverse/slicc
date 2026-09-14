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

interface SessionSnapshot {
  trayId: string;
  joinUrl: string;
  webhookUrl: string;
}

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

async function deliver(url: string, marker: string): Promise<Response> {
  expect(new URL(url).origin).toBe(LEADER_ORIGIN);
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'render-finished', marker }),
  });
}

test.describe('roving tray — webhook URLs across a reset', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test('the stable webhook URL survives a reset invisibly', async ({ page }) => {
    test.setTimeout(CONE_TEST_TIMEOUT_MS);
    await bootMultiConeLeader(page, { fixture: rovingFixture, tray: true });
    await leaderJoinUrl(page);
    const before = await leaderSession(page);
    expect(new URL(before.joinUrl).origin).toBe(LEADER_ORIGIN);
    expect(new URL(before.webhookUrl).origin).toBe(LEADER_ORIGIN);

    const created = await execInTerminal(page, 'webhook create --name rove-hook');
    expect(created.exitCode).toBe(0);
    const hookUrl = /^URL: (\S+)$/m.exec(created.stdout)?.[1];
    expect(hookUrl, `webhook create output:\n${created.stdout}`).toBeTruthy();

    expect(hookUrl).toContain('/wh/');
    expect(hookUrl).not.toContain(before.trayId);

    const first = await deliver(hookUrl!, 'marker-one');
    expect(first.status).toBe(202);
    expect(((await first.json()) as { ok?: boolean }).ok).toBe(true);
    await expect(thread(page)).toContainText('Rove event one received.', { timeout: 90_000 });

    const reset = await execInTerminal(page, 'host reset');
    expect(reset.exitCode).toBe(0);
    await expect
      .poll(async () => (await leaderSession(page)).trayId, { timeout: 60_000 })
      .not.toBe(before.trayId);
    const after = await leaderSession(page);

    expect(after.webhookUrl).toBe(before.webhookUrl);

    const second = await deliver(hookUrl!, 'marker-two');
    expect(second.status).toBe(202);
    expect(second.headers.get('location')).toBeNull();
    const secondBody = await second.text();
    expect(secondBody).not.toContain(after.trayId);
    expect((JSON.parse(secondBody) as { ok?: boolean }).ok).toBe(true);
    await expect(thread(page)).toContainText('Rove event two received.', { timeout: 90_000 });

    const joinProbe = await fetch(`${before.joinUrl}?json=true`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    expect(joinProbe.status).toBe(308);
    expect(joinProbe.headers.get('location')).toBe(`${after.joinUrl}?json=true`);

    const rotated = await execInTerminal(page, 'webhook rotate');
    expect(rotated.exitCode, rotated.stderr).toBe(0);
    expect((await deliver(hookUrl!, 'retired-secret')).status).toBe(403);
    const listed = await execInTerminal(page, 'webhook list');
    expect(listed.exitCode).toBe(0);
    const replacement = listed.stdout.match(/https?:\/\/[^\s]+\/wh\/[^\s]+/)?.[0];
    expect(replacement, listed.stdout).toBeTruthy();
    expect(replacement).not.toBe(hookUrl);
    expect((await deliver(replacement!, 'marker-three')).status).toBe(202);
    await expect(thread(page)).toContainText('Rotated event received.', { timeout: 90_000 });

    const leaderUrl = page.url();
    await page.goto('about:blank', { timeout: 30_000 });
    expect((await deliver(replacement!, 'marker-four')).status).toBe(202);
    await page.goto(leaderUrl, { timeout: 45_000 });
    await leaderSession(page);
    await expect(thread(page)).toContainText('Queued event received.', { timeout: 90_000 });

    const rotatedAgain = await execInTerminal(page, 'webhook rotate');
    expect(rotatedAgain.exitCode, rotatedAgain.stderr).toBe(0);
    const listedAgain = await execInTerminal(page, 'webhook list');
    expect(listedAgain.exitCode).toBe(0);
    const latest = listedAgain.stdout.match(/https?:\/\/[^\s]+\/wh\/[^\s]+/)?.[0];
    expect(latest, listedAgain.stdout).toBeTruthy();
    expect(latest).not.toBe(replacement);
    expect(latest).not.toBe(hookUrl);
    expect((await deliver(replacement!, 'retired-second-secret')).status).toBe(403);
    expect((await deliver(latest!, 'marker-five')).status).toBe(202);
    await expect(thread(page)).toContainText('Reloaded rotation event received.', {
      timeout: 90_000,
    });

    const hookId = /^ID:\s+(\S+)$/m.exec(created.stdout)?.[1];
    expect(hookId).toBeTruthy();
    const deleted = await execInTerminal(page, `webhook delete ${hookId}`);
    expect(deleted.exitCode, deleted.stderr).toBe(0);
    expect((await deliver(latest!, 'deleted-registration')).status).toBe(410);

    const resetAgain = await execInTerminal(page, 'host reset');
    expect(resetAgain.exitCode).toBe(0);
    await expect
      .poll(async () => (await leaderSession(page)).trayId, { timeout: 60_000 })
      .not.toBe(after.trayId);
    expect((await deliver(latest!, 'still-deleted')).status).toBe(410);
  });

  test('the original preview URL still serves after host reset', async ({ page, context }) => {
    test.setTimeout(CONE_TEST_TIMEOUT_MS);
    await bootMultiConeLeader(page, { fixture: rovingFixture, tray: true });
    await leaderJoinUrl(page);
    const before = await leaderSession(page);
    expect(new URL(before.joinUrl).origin).toBe(LEADER_ORIGIN);
    const setup = await execInTerminal(
      page,
      "mkdir -p /workspace/rove-preview; echo '<html><body>stable-rove-preview</body></html>' > /workspace/rove-preview/index.html"
    );
    expect(setup.exitCode).toBe(0);
    const served = await execInTerminal(page, 'serve --quiet --no-bridge /workspace/rove-preview');
    expect(served.exitCode, served.stderr).toBe(0);
    const previewUrl = /^Preview URL: (\S+)/m.exec(served.stdout)?.[1];
    expect(previewUrl).toBeTruthy();
    const parsed = new URL(previewUrl!);
    expect(parsed.hostname.endsWith('.localhost')).toBe(true);
    expect(parsed.port).toBe(new URL(LEADER_ORIGIN).port);
    expect(parsed.protocol).toBe('http:');

    const visitor = await context.newPage();
    expect((await visitor.goto(previewUrl!, { timeout: 30_000 }))?.status()).toBe(200);
    await expect(visitor.locator('body')).toContainText('stable-rove-preview');
    const reset = await execInTerminal(page, 'host reset');
    expect(reset.exitCode).toBe(0);
    await expect
      .poll(async () => (await leaderSession(page)).trayId, { timeout: 60_000 })
      .not.toBe(before.trayId);
    expect((await visitor.goto(previewUrl!, { timeout: 30_000 }))?.status()).toBe(200);
    await expect(visitor.locator('body')).toContainText('stable-rove-preview');
  });
});
