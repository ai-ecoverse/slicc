import sidecarFixture from './fake-llm/fixtures/slicc-sidecar.json' with { type: 'json' };
import { resetFakeLlm } from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import type { BrowserDiagnostics } from './two-instance-helpers.js';
import {
  bootMultiConeLeader,
  bootSecondLeader,
  execInTerminal,
  leaderJoinUrl,
  TWO_INSTANCE_TEST_TIMEOUT_MS,
  thread,
  watchBrowserDiagnostics,
} from './two-instance-helpers.js';

test.describe('slicc sidecar — client verbs against another leader', () => {
  test.describe.configure({ retries: 1 });

  let current: BrowserDiagnostics | null = null;

  test.beforeEach(async () => {
    current = null;
    await resetFakeLlm();
  });

  // biome-ignore lint/correctness/noEmptyPattern: see above
  test.afterEach(({}, testInfo) => {
    if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;
    const tail = current?.entries.slice(-40).join('\n');
    console.log(
      `--- browser diagnostics for "${testInfo.title}" (${testInfo.status}) ---\n${
        tail || '(nothing captured)'
      }`
    );
  });

  test('exec and prompt reach the remote leader, and the caller keeps its own role', async ({
    page,
    browser,
  }) => {
    test.setTimeout(TWO_INSTANCE_TEST_TIMEOUT_MS);
    const diagnostics = watchBrowserDiagnostics(page, 'A');
    current = diagnostics;

    await bootMultiConeLeader(page, { fixture: sidecarFixture, tray: true });
    const joinUrl = await leaderJoinUrl(page);
    expect(joinUrl).toContain('/join/');

    const marker = `sidecar-${joinUrl.split('/').pop()?.slice(0, 8)}-marker`;
    const markerPath = `/tmp/${marker}.txt`;
    const wrote = await execInTerminal(page, `echo ${marker} > ${markerPath}`);
    expect(wrote.exitCode).toBe(0);

    const b = await bootSecondLeader(browser, { fixture: sidecarFixture, tray: true });
    watchBrowserDiagnostics(b.page, 'B', diagnostics);
    try {
      const bJoinUrlBefore = await leaderJoinUrl(b.page);
      expect(bJoinUrlBefore).not.toBe(joinUrl);

      const local = await execInTerminal(b.page, `cat ${markerPath}`);
      expect(local.exitCode).not.toBe(0);

      const remote = await execInTerminal(
        b.page,
        `slicc ${joinUrl} exec "cat ${markerPath}"`,
        120_000
      );
      expect(remote.stderr).not.toContain('slicc:');
      expect(remote.exitCode).toBe(0);
      expect(remote.stdout).toContain(marker);

      const failing = await execInTerminal(
        b.page,
        `slicc ${joinUrl} exec "cat /tmp/definitely-not-here.txt"`,
        120_000
      );
      expect(failing.exitCode).not.toBe(0);

      const hostAfter = await execInTerminal(b.page, 'host');
      expect(hostAfter.stdout).toContain('leader');
      expect(await leaderJoinUrl(b.page)).toBe(bJoinUrlBefore);

      const listed = await execInTerminal(b.page, 'slicc list');
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain('connected');

      const name = /^\s+- (\S+) \(/m.exec(listed.stdout)?.[1];
      expect(name, `no attachment name in:\n${listed.stdout}`).toBeTruthy();

      const byName = await execInTerminal(b.page, `slicc ${name} exec "echo reused"`, 120_000);
      expect(byName.exitCode).toBe(0);
      expect(byName.stdout).toContain('reused');

      const answered = await execInTerminal(
        b.page,
        `slicc ${joinUrl} prompt "who are you"`,
        180_000
      );
      expect(answered.stderr).not.toContain('slicc:');
      expect(answered.exitCode).toBe(0);

      expect(answered.stdout).toContain('I am the remote leader.');

      await expect(thread(page)).toContainText('who are you', { timeout: 30_000 });
      await expect(thread(page)).toContainText('I am the remote leader.', {
        timeout: 30_000,
      });

      const detached = await execInTerminal(b.page, `slicc detach ${name}`);
      expect(detached.exitCode).toBe(0);
      expect((await execInTerminal(b.page, 'slicc list')).stdout).toContain('No attachments');
    } finally {
      await b.close();
    }
  });

  test('refuses to attach to its own tray', async ({ page }) => {
    test.setTimeout(TWO_INSTANCE_TEST_TIMEOUT_MS);
    current = watchBrowserDiagnostics(page, 'A');

    await bootMultiConeLeader(page, { fixture: sidecarFixture, tray: true });
    const ownJoinUrl = await leaderJoinUrl(page);

    const refused = await execInTerminal(page, `slicc ${ownJoinUrl} exec "echo nope"`, 60_000);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('own tray');

    expect(await leaderJoinUrl(page)).toBe(ownJoinUrl);
  });
});
