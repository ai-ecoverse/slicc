import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';
import { openTerminal } from './two-instance-helpers.js';

// Keep the collapsible body outside <summary>: Review once put all of a
// source's explanation inside it, making a working disclosure look stuck.
const DISCLOSURES = `
<style>
  .disclosure-probe { padding: 16px; }
  .disclosure-probe details { margin-bottom: 16px; }
  .disclosure-probe .custom > summary { display: flex; gap: 4px; list-style: none; }
  .disclosure-probe .custom > summary::-webkit-details-marker { display: none; }
  .disclosure-probe .chevron { display: inline-block; }
  .disclosure-probe details[open] .chevron { transform: rotate(90deg); }
</style>
<div class="disclosure-probe">
  <details class="native">
    <summary>Review findings <span class="always-visible">Check</span></summary>
    <div class="body sprinkle-detail">Preview only · never published</div>
  </details>
  <details class="custom">
    <summary><span class="chevron" aria-hidden="true">›</span>Agent brief</summary>
    <div class="body sprinkle-detail">Follow up after the next review.</div>
  </details>
</div>`;

async function bootWithoutOpenSprinkles(page: Page): Promise<void> {
  await gotoLeader(page, '/?sprinkles=');
  await waitForSW(page);
  await page.waitForSelector('slicc-input-card');
  // Unlike the first-run welcome, the terminal's kernel-ready signal
  // survives a reload (the same readiness gate used by speech recovery).
  await openTerminal(page, 20_000);
  await page.waitForFunction(() => Boolean(window.__slicc_sprinkleManager));
}

for (const { mode, kind } of [
  { mode: 'fragment', kind: 'native' },
  { mode: 'fragment', kind: 'custom' },
  { mode: 'document', kind: 'native' },
  { mode: 'document', kind: 'custom' },
] as const) {
  test(`sprinkle ${mode} keeps ${kind} disclosure mouse and keyboard behavior`, async ({
    page,
  }) => {
    // Cold boot plus cross-frame input/visibility probes can each take
    // seconds on CI. Keep each marker variant within its own budget.
    test.setTimeout(120_000);
    await seedSkipSwReload(page);
    await bootWithoutOpenSprinkles(page);
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    const name = `e2e-details-${mode}`;
    const html =
      mode === 'document'
        ? `<!doctype html><html><head><title>Disclosure probe</title></head><body>${DISCLOSURES}</body></html>`
        : DISCLOSURES;
    await page.evaluate(
      async ({ name, html }) => {
        const manager = window.__slicc_sprinkleManager;
        if (!manager) throw new Error('Sprinkle manager missing');
        const dir = `/shared/sprinkles/${name}`;
        await manager.fs.mkdir(dir, { recursive: true });
        await manager.fs.writeFile(`${dir}/${name}.shtml`, html);
      },
      { name, html }
    );

    // Install before the final boot so the VFS hot-reload event cannot
    // race the first iframe render. The explicit empty open set also keeps
    // boot discovery from opening the fixture alongside our setup below.
    await bootWithoutOpenSprinkles(page);
    await page.evaluate(async (name) => {
      const manager = window.__slicc_sprinkleManager;
      if (!manager) throw new Error('Sprinkle manager missing');
      await manager.refresh();
      await manager.open(name, undefined, { attention: true });
    }, name);

    const panel = page.locator(`[data-sprinkle="${name}"]`);
    await expect(panel).toBeHidden();
    await page
      .getByRole('button', { name: mode === 'document' ? 'Disclosure probe' : name, exact: true })
      .click();
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const root = mode === 'document' ? panel.frameLocator('iframe') : panel;
    const details = root.locator(`details.${kind}`);
    const summary = details.locator('summary');
    // Query the attribute and rendered body together in one iframe call.
    // checkVisibility includes the ancestor's content-visibility: Chromium
    // retains layout boxes for the closed ::details-content.
    const disclosureState = () =>
      details.evaluateAll(([element]) =>
        element
          ? {
              open: element.hasAttribute('open'),
              bodyVisible: element.querySelector('.body')?.checkVisibility(),
              height: element.clientHeight,
            }
          : null
      );
    await expect(summary).toBeVisible();
    await expect.poll(disclosureState).toMatchObject({ open: false, bodyVisible: false });
    const closedHeight = (await disclosureState())!.height;

    await summary.click();
    await expect.poll(disclosureState).toMatchObject({ open: true, bodyVisible: true });
    expect((await disclosureState())!.height).toBeGreaterThan(closedHeight);
    await summary.click();
    await expect.poll(disclosureState).toMatchObject({ open: false, bodyVisible: false });

    await summary.focus();
    await summary.press('Enter');
    await expect.poll(disclosureState).toMatchObject({ open: true, bodyVisible: true });
    await summary.press('Space');
    await expect.poll(disclosureState).toMatchObject({ open: false, bodyVisible: false });
    await expect(summary).toBeFocused();
    // <summary> descendants always remain visible; moving collapsible text
    // into this span would defeat the body assertions above.
    await expect(root.locator('.always-visible')).toBeVisible();
  });
}
