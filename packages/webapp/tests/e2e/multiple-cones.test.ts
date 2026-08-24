// packages/webapp/tests/e2e/multiple-cones.test.ts
/**
 * Multiple-cones E2E on the leader (#2313, part of #1666).
 *
 * Everything here runs against the real WC shell with the `multiple-cones`
 * flag on and the fake LLM as the provider: cones are created and dropped
 * through the freezer rail's action row, turns really stream, scoops are
 * really registered by `scoop_scoop`, and the freezer index is read back out
 * of the worker's VFS.
 *
 * The follower half of #2313 lives in `multiple-cones-follower.test.ts`, licks
 * in `multiple-cones-licks.test.ts`; the shared topology helpers in
 * `two-instance-helpers.ts`.
 */

import multipleConesFixture from './fake-llm/fixtures/multiple-cones.json' with { type: 'json' };
import railFixture from './fake-llm/fixtures/multiple-cones-rail.json' with { type: 'json' };
import { resetFakeLlm } from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import {
  activeTabLabel,
  bootMultiConeLeader,
  CONE_TEST_TIMEOUT_MS,
  chat,
  clickRailAction,
  createCone,
  dropSelectedCone,
  expandFreezerRail,
  expectReply,
  freezerCardTitles,
  openFreezerCard,
  PRIMARY_CONE_LABEL,
  railAction,
  readFreezerIndex,
  selectTab,
  switcherLabels,
  thread,
} from './two-instance-helpers.js';

test.describe('multiple cones — leader', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test('create, chat, spawn a scoop, switch and drop cones', async ({ page }) => {
    test.setTimeout(CONE_TEST_TIMEOUT_MS);
    await bootMultiConeLeader(page, { fixture: multipleConesFixture });

    // One cone to start with: the bootstrapped primary root.
    expect(await switcherLabels(page)).toEqual([PRIMARY_CONE_LABEL]);

    // The last-cone guard — the row hides "Drop cone" while one cone is left.
    await expandFreezerRail(page);
    await expect(railAction(page, 'new-cone')).toBeVisible();
    await expect(railAction(page, 'drop-cone')).toHaveCount(0);

    // A brief starts the cone's first turn immediately.
    await createCone(page, { name: 'reviewer', brief: 'review the docs' });
    await expectReply(page, 'Reviewer cone online.');
    expect(await activeTabLabel(page)).toBe('reviewer');

    // A scoop spawned from the new cone sits behind the cones in the strip.
    await chat(page, 'spawn a helper scoop', 'Helper scoop is ready.');
    await expect
      .poll(() => switcherLabels(page), { timeout: 30_000 })
      .toEqual([PRIMARY_CONE_LABEL, 'reviewer', 'helper']);

    // Cones stay first when the selection moves; with the primary cone
    // selected, the other cone's scoop is in the tail rather than promoted.
    await selectTab(page, PRIMARY_CONE_LABEL);
    await expect.poll(() => activeTabLabel(page), { timeout: 15_000 }).toBe(PRIMARY_CONE_LABEL);
    expect((await switcherLabels(page)).slice(0, 2)).toEqual([PRIMARY_CONE_LABEL, 'reviewer']);

    // Give the primary cone a chat worth freezing — a session under
    // `MIN_MESSAGES_TO_FREEZE` is skipped by the freezer on purpose.
    await chat(page, 'sliccy note one', 'Noted one.');
    await chat(page, 'sliccy note two', 'Noted two.');

    // With two cones the drop action is offered again.
    await expandFreezerRail(page);
    await expect(railAction(page, 'drop-cone')).toBeVisible();

    // Dropping the OLDEST root (the primary one) promotes the next-oldest:
    // `reviewer` becomes both the selection and the head of the strip.
    await dropSelectedCone(page, PRIMARY_CONE_LABEL);
    await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe('reviewer');
    expect((await switcherLabels(page))[0]).toBe('reviewer');

    // The dropped cone's chat went to the Freezer, and it went there without
    // a memory pass — that is what "drop" means (#2272).
    await expect.poll(() => freezerCardTitles(page), { timeout: 60_000 }).not.toEqual([]);
    const index = await readFreezerIndex(page);
    expect(index.length).toBeGreaterThan(0);
    expect(index.some((entry) => entry.memorySkipped === true)).toBe(true);

    // And the guard is back: `reviewer` is now the last cone.
    await expandFreezerRail(page);
    await expect(railAction(page, 'drop-cone')).toHaveCount(0);
  });

  test('rail row actions: new chat, fast and discard, with freezer outcomes', async ({ page }) => {
    test.setTimeout(CONE_TEST_TIMEOUT_MS);
    await bootMultiConeLeader(page, { fixture: railFixture });

    await createCone(page, { name: 'reviewer', brief: 'review the docs' });
    await expectReply(page, 'Reviewer cone online.');
    await chat(page, 'round one alpha', 'Ack alpha.');
    await chat(page, 'round one beta', 'Ack beta.');

    // ── New chat (save): archive + memory extraction, then clear ──────
    await clickRailAction(page, 'new-chat-save');
    await expect(thread(page)).not.toContainText('Ack alpha.', { timeout: 90_000 });
    await expect.poll(() => freezerCardTitles(page), { timeout: 90_000 }).not.toEqual([]);
    const afterSave = await readFreezerIndex(page);
    expect(afterSave).toHaveLength(1);
    // The archive belongs to the cone it was frozen from, not to the primary
    // one — one Freezer, cone attribution on the entry (#2272).
    expect(afterSave[0]?.cone).toBe('cone-reviewer');
    expect(afterSave[0]?.memorySkipped).toBeUndefined();

    // A thawed chat says whose cone it came from, in the chat log.
    await openFreezerCard(page, afterSave[0]?.title ?? '');
    await expect(page.locator('slicc-day-separator[data-frozen-provenance]')).toHaveAttribute(
      'label',
      'Frozen chat · from cone reviewer',
      { timeout: 30_000 }
    );

    // ── New chat, fast: a second archive, memories back-filled later ──
    await selectTab(page, 'reviewer');
    await chat(page, 'round two alpha', 'Ack second alpha.');
    await chat(page, 'round two beta', 'Ack second beta.');
    await clickRailAction(page, 'new-chat-skip');
    await expect(thread(page)).not.toContainText('Ack second alpha.', { timeout: 90_000 });
    await expect
      .poll(async () => (await readFreezerIndex(page)).length, { timeout: 90_000 })
      .toBe(2);

    // ── Discard: no freezer entry at all ──────────────────────────────
    await selectTab(page, 'reviewer');
    await chat(page, 'round three alpha', 'Ack third alpha.');
    await chat(page, 'round three beta', 'Ack third beta.');
    await clickRailAction(page, 'new-chat-erase');
    await expect(thread(page)).not.toContainText('Ack third alpha.', { timeout: 90_000 });
    // Give a would-be archive the same budget the two above needed before
    // concluding that nothing was written.
    await page.waitForTimeout(5_000);
    expect(await readFreezerIndex(page)).toHaveLength(2);
  });
});
