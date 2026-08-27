// packages/webapp/tests/e2e/slicc-sidecar.test.ts
/**
 * Two-instance E2E for the `slicc` shell command: one SLICC leader talking to
 * ANOTHER SLICC leader as a client, over a REAL tray hub — the harness's own
 * `wrangler dev` of `packages/cloudflare-worker`, Durable Objects and all.
 * Nothing about the tray, the signaling, or the WebRTC data channel is stubbed.
 *
 * The topology is deliberately NOT the follower one in
 * `multiple-cones-follower.test.ts`. A follower has GIVEN UP its own role to
 * mirror the leader; that is exactly the state a sidecar must not require. Here
 * both runtimes are leaders of their own trays on the same hub, and one of them
 * attaches a sidecar to the other (see `bootSecondLeader`).
 *
 * What only a live run can prove, and unit tests cannot:
 *
 *   - `exec` really executes in the REMOTE leader's VFS. Asserted the only way
 *     that is not self-confirming: instance A writes a marker file, B fails to
 *     read it locally, and B reads it through the sidecar. Two different
 *     filesystems, one command.
 *   - `prompt` really drives the remote AGENT — the reply comes from the remote
 *     instance's model, and appears in the remote instance's transcript.
 *   - Attaching does NOT change the attaching instance's role. `host join` at
 *     this point would have stopped B's leader and handed away its UI; this
 *     leaves B leading its own tray with its own join URL.
 *   - The self-attach refusal fires against a REAL join URL, not a fabricated
 *     one — the case that would otherwise deadlock the leader thread.
 *
 * See `two-instance-helpers.ts` for the topology.
 */

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
  // Same budget rationale as the follower spec: two runtimes plus a real tray
  // is the expensive shape, and a third attempt at a 10-minute ceiling would
  // starve the specs after it.
  test.describe.configure({ retries: 1 });

  /**
   * Diagnostics for the CURRENT test, dumped by the afterEach below.
   *
   * `annotate(err)` only fires for a thrown error; a Playwright TEST TIMEOUT
   * aborts the body instead, so the catch never runs and the console tail — the
   * only record of what the two runtimes were doing — is lost. `afterEach`
   * still runs after a timeout, which makes it the one place that reports on
   * the failure mode this spec actually suffers in CI.
   */
  let current: BrowserDiagnostics | null = null;

  test.beforeEach(async () => {
    current = null;
    await resetFakeLlm();
  });

  // Playwright REQUIRES the fixtures parameter to be a destructuring pattern
  // ("First argument must use the object destructuring pattern") and this hook
  // needs no fixture, so the empty pattern is the only shape that works.
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

    // ── Instance A: leader with a real tray on the local worker ──────────
    await bootMultiConeLeader(page, { fixture: sidecarFixture, tray: true });
    const joinUrl = await leaderJoinUrl(page);
    expect(joinUrl).toContain('/join/');

    // A marker that exists ONLY in A's filesystem. This is what makes the
    // assertion below non-circular: any command that merely succeeds could
    // have run locally, but only A's shell can read this file.
    const marker = `sidecar-${joinUrl.split('/').pop()?.slice(0, 8)}-marker`;
    const markerPath = `/tmp/${marker}.txt`;
    const wrote = await execInTerminal(page, `echo ${marker} > ${markerPath}`);
    expect(wrote.exitCode).toBe(0);

    // ── Instance B: a second, independent leader on the same hub ─────────
    const b = await bootSecondLeader(browser, { fixture: sidecarFixture, tray: true });
    watchBrowserDiagnostics(b.page, 'B', diagnostics);
    try {
      const bJoinUrlBefore = await leaderJoinUrl(b.page);
      expect(bJoinUrlBefore).not.toBe(joinUrl);

      // B cannot see A's marker: separate runtimes, separate VFS.
      const local = await execInTerminal(b.page, `cat ${markerPath}`);
      expect(local.exitCode).not.toBe(0);

      // …but it can read it through A's shell. This is the whole feature.
      const remote = await execInTerminal(
        b.page,
        `slicc ${joinUrl} exec "cat ${markerPath}"`,
        120_000
      );
      expect(remote.stderr).not.toContain('slicc:');
      expect(remote.exitCode).toBe(0);
      expect(remote.stdout).toContain(marker);

      // The remote exit code is the REMOTE command's, not the transport's.
      const failing = await execInTerminal(
        b.page,
        `slicc ${joinUrl} exec "cat /tmp/definitely-not-here.txt"`,
        120_000
      );
      expect(failing.exitCode).not.toBe(0);

      // ── Not a role switch ────────────────────────────────────────────
      // `host join` here would have stopped B's leader and released its lock.
      const hostAfter = await execInTerminal(b.page, 'host');
      expect(hostAfter.stdout).toContain('leader');
      expect(await leaderJoinUrl(b.page)).toBe(bJoinUrlBefore);

      // ── The attachment is listed, reusable, and droppable ────────────
      const listed = await execInTerminal(b.page, 'slicc list');
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain('connected');

      const name = /^\s+- (\S+) \(/m.exec(listed.stdout)?.[1];
      expect(name, `no attachment name in:\n${listed.stdout}`).toBeTruthy();

      // Addressing it by NAME reuses the warm connection — no second dial.
      const byName = await execInTerminal(b.page, `slicc ${name} exec "echo reused"`, 120_000);
      expect(byName.exitCode).toBe(0);
      expect(byName.stdout).toContain('reused');

      // ── prompt drives the remote AGENT, not just its shell ───────────
      // Kept in this test rather than its own: it needs the same two-runtime
      // topology, and a second boot of it is the most expensive thing this
      // spec can ask of the shared e2e budget.
      const answered = await execInTerminal(
        b.page,
        `slicc ${joinUrl} prompt "who are you"`,
        180_000
      );
      expect(answered.stderr).not.toContain('slicc:');
      expect(answered.exitCode).toBe(0);
      // The reply is A's fixture turn, streamed back as content deltas and
      // reassembled by the sidecar.
      expect(answered.stdout).toContain('I am the remote leader.');

      // And it was a real turn on A, not a side channel: both the question
      // and the answer are in A's transcript.
      await expect(thread(page)).toContainText('who are you', { timeout: 30_000 });
      await expect(thread(page)).toContainText('I am the remote leader.', {
        timeout: 30_000,
      });

      // ── Detach drops it ──────────────────────────────────────────────
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

    // Self-attach would deadlock: the leader tray runs on this same page
    // thread, so the exec would block waiting for a reply that thread has to
    // produce. The guard has to fire against a REAL join URL — a fabricated one
    // exercises the string compare but not the case that actually hangs.
    const refused = await execInTerminal(page, `slicc ${ownJoinUrl} exec "echo nope"`, 60_000);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('own tray');

    // The refusal is a no-op on the tray: still leading, still the same URL.
    expect(await leaderJoinUrl(page)).toBe(ownJoinUrl);
  });
});
