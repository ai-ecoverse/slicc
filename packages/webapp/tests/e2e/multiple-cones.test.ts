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

    expect(await switcherLabels(page)).toEqual([PRIMARY_CONE_LABEL]);

    await expandFreezerRail(page);
    await expect(railAction(page, 'new-cone')).toBeVisible();
    await expect(railAction(page, 'drop-cone')).toHaveCount(0);

    await createCone(page, { name: 'reviewer', brief: 'review the docs' });
    await expectReply(page, 'Reviewer cone online.');
    expect(await activeTabLabel(page)).toBe('reviewer');

    await chat(page, 'spawn a helper scoop', 'Helper scoop is ready.');
    await expect
      .poll(() => switcherLabels(page), { timeout: 30_000 })
      .toEqual([PRIMARY_CONE_LABEL, 'reviewer', 'helper']);

    await selectTab(page, PRIMARY_CONE_LABEL);
    await expect.poll(() => activeTabLabel(page), { timeout: 15_000 }).toBe(PRIMARY_CONE_LABEL);
    expect((await switcherLabels(page)).slice(0, 2)).toEqual([PRIMARY_CONE_LABEL, 'reviewer']);

    await chat(page, 'sliccy note one', 'Noted one.');
    await chat(page, 'sliccy note two', 'Noted two.');

    await expandFreezerRail(page);
    await expect(railAction(page, 'drop-cone')).toBeVisible();

    await dropSelectedCone(page, PRIMARY_CONE_LABEL);
    await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe('reviewer');
    expect((await switcherLabels(page))[0]).toBe('reviewer');

    await expect.poll(() => freezerCardTitles(page), { timeout: 60_000 }).not.toEqual([]);
    const index = await readFreezerIndex(page);
    expect(index.length).toBeGreaterThan(0);
    expect(index.some((entry) => entry.memorySkipped === true)).toBe(true);

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

    await clickRailAction(page, 'new-chat-save');
    await expect(thread(page)).not.toContainText('Ack alpha.', { timeout: 90_000 });
    await expect.poll(() => freezerCardTitles(page), { timeout: 90_000 }).not.toEqual([]);
    const afterSave = await readFreezerIndex(page);
    expect(afterSave).toHaveLength(1);

    expect(afterSave[0]?.cone).toBe('cone-reviewer');
    expect(afterSave[0]?.memorySkipped).toBeUndefined();

    await openFreezerCard(page, afterSave[0]?.title ?? '');
    await expect(page.locator('slicc-day-separator[data-frozen-provenance]')).toHaveAttribute(
      'label',
      'Frozen chat · from cone reviewer',
      { timeout: 30_000 }
    );

    await selectTab(page, 'reviewer');
    await chat(page, 'round two alpha', 'Ack second alpha.');
    await chat(page, 'round two beta', 'Ack second beta.');
    await clickRailAction(page, 'new-chat-skip');
    await expect(thread(page)).not.toContainText('Ack second alpha.', { timeout: 90_000 });
    await expect
      .poll(async () => (await readFreezerIndex(page)).length, { timeout: 90_000 })
      .toBe(2);

    await selectTab(page, 'reviewer');
    await chat(page, 'round three alpha', 'Ack third alpha.');
    await chat(page, 'round three beta', 'Ack third beta.');
    await clickRailAction(page, 'new-chat-erase');
    await expect(thread(page)).not.toContainText('Ack third alpha.', { timeout: 90_000 });

    await page.waitForTimeout(5_000);
    expect(await readFreezerIndex(page)).toHaveLength(2);
  });
});
