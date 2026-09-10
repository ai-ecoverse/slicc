import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

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

for (const mode of ['fragment', 'document'] as const) {
  test(`sprinkle ${mode} keeps native disclosure mouse and keyboard behavior`, async ({ page }) => {
    test.setTimeout(90_000);
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC');
    await page.waitForFunction(() => Boolean(window.__slicc_sprinkleManager));

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
        await manager.refresh();
        await manager.open(name);
      },
      { name, html }
    );

    const panel = page.locator(`[data-sprinkle="${name}"]`);
    if (!(await panel.isVisible())) {
      await page
        .getByRole('button', { name: mode === 'document' ? 'Disclosure probe' : name, exact: true })
        .click();
    }
    const root = mode === 'document' ? panel.frameLocator('iframe') : panel;
    for (const kind of ['native', 'custom']) {
      const details = root.locator(`details.${kind}`);
      const summary = details.locator('summary');
      const body = details.locator('.body');
      // Visibility checks must include the ancestor's content-visibility:
      // Chromium retains layout boxes for the closed ::details-content.
      const bodyVisible = () => body.evaluate((element) => element.checkVisibility());
      await expect(summary).toBeVisible();
      await expect(details).not.toHaveAttribute('open');
      await expect.poll(bodyVisible).toBe(false);
      const closedHeight = await details.evaluate((element) => element.clientHeight);

      await summary.click();
      await expect(details).toHaveAttribute('open', '');
      await expect.poll(bodyVisible).toBe(true);
      expect(await details.evaluate((element) => element.clientHeight)).toBeGreaterThan(
        closedHeight
      );
      await summary.click();
      await expect(details).not.toHaveAttribute('open');
      await expect.poll(bodyVisible).toBe(false);

      await summary.focus();
      await summary.press('Enter');
      await expect(details).toHaveAttribute('open', '');
      await expect.poll(bodyVisible).toBe(true);
      await summary.press('Space');
      await expect(details).not.toHaveAttribute('open');
      await expect.poll(bodyVisible).toBe(false);
      await expect(summary).toBeFocused();
    }
    // <summary> descendants always remain visible; moving collapsible text
    // into this span would defeat the body assertions above.
    await expect(root.locator('.always-visible')).toBeVisible();
  });
}
