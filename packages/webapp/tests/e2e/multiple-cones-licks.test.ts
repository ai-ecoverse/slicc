// packages/webapp/tests/e2e/multiple-cones-licks.test.ts
/**
 * Lick addressing across several cones (#2313 scenario 4, the runtime half of
 * #2311).
 *
 * Two dispositions, one extra cone, real `fswatch` watchers on the real VFS:
 *
 *   - **untargeted, created from an extra cone's shell** — the agent in cone
 *     `watcher` runs `fswatch create` with no `--scoop`, so the watcher inherits
 *     `SLICC_LICK_TARGET` (that cone's folder) and its events come back to
 *     *that* cone, not to the oldest root.
 *   - **addressed by cone name** — a watcher created with `--scoop watcher`
 *     resolves the cone by NAME and delivers there.
 *
 * Both are asserted twice over: the event shows up in the cone that owns it AND
 * is absent from the primary cone, which is where a regression would send it.
 */

import { expect, test } from '@playwright/test';
import licksFixture from './fake-llm/fixtures/multiple-cones-licks.json' with { type: 'json' };
import { resetFakeLlm } from './fake-llm-helpers.js';
import {
  bootMultiConeLeader,
  CONE_TEST_TIMEOUT_MS,
  createCone,
  execInTerminal,
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

    // The extra cone registers its own watcher, from its own shell, with no
    // `--scoop` — the untargeted case.
    await createCone(page, { name: 'watcher', brief: 'watch for your own notes' });
    await expect(thread(page)).toContainText('Watching for my own notes.', { timeout: 60_000 });

    // A watcher addressed at the cone BY NAME, created from a shell that is
    // not that cone's.
    const created = await execInTerminal(
      page,
      "fswatch create --path /tmp --pattern 'named-*.md' --scoop watcher --name named-feed"
    );
    expect(created.stdout).toContain('named-feed');

    // Fire both watchers. `/tmp` is shared by every unit, so the writes
    // themselves say nothing about who should hear about them.
    await execInTerminal(page, 'echo own > /tmp/own-1.md');
    await expect(thread(page)).toContainText('Own note seen.', { timeout: 90_000 });

    await execInTerminal(page, 'echo named > /tmp/named-1.md');
    await expect(thread(page)).toContainText('Named note seen.', { timeout: 90_000 });

    // Neither event went to the oldest root.
    await selectTab(page, PRIMARY_CONE_LABEL);
    await expect(thread(page)).not.toContainText('File Watch Event', { timeout: 15_000 });
    await expect(thread(page)).not.toContainText('Own note seen.');
    await expect(thread(page)).not.toContainText('Named note seen.');
  });
});
