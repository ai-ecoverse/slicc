import licksFixture from './fake-llm/fixtures/multiple-cones-licks.json' with { type: 'json' };
import { resetFakeLlm } from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import {
  bootMultiConeLeader,
  CONE_TEST_TIMEOUT_MS,
  createCone,
  execInTerminal,
  expectReply,
  PRIMARY_CONE_LABEL,
  selectTab,
  thread,
} from './two-instance-helpers.js';

test.describe('multiple cones — lick addressing', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test('licks land in the cone that owns them, not the primary one', async ({ page }) => {
    test.setTimeout(CONE_TEST_TIMEOUT_MS);
    await bootMultiConeLeader(page, { fixture: licksFixture });

    await createCone(page, { name: 'watcher', brief: 'watch for your own notes' });
    await expectReply(page, 'Watching for my own notes.');

    const created = await execInTerminal(
      page,
      "fswatch create --path /tmp --pattern 'named-*.md' --scoop watcher --name named-feed"
    );
    expect(created.stdout).toContain('named-feed');

    await execInTerminal(page, 'echo own > /tmp/own-1.md');
    await expect(thread(page)).toContainText('Own note seen.', { timeout: 90_000 });

    await execInTerminal(page, 'echo named > /tmp/named-1.md');
    await expect(thread(page)).toContainText('Named note seen.', { timeout: 90_000 });

    await selectTab(page, PRIMARY_CONE_LABEL);
    await expect(thread(page)).not.toContainText('File Watch Event', { timeout: 15_000 });
    await expect(thread(page)).not.toContainText('Own note seen.');
    await expect(thread(page)).not.toContainText('Named note seen.');
  });
});
