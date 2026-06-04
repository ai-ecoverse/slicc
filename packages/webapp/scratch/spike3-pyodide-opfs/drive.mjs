// Headless Chrome driver — runs both variants of the prototype against
// a Chrome instance with remote debugging on port 9333 and prints the
// captured log + OPFS read-back. Used to populate the findings note.
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333' });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8765/index.html', { waitUntil: 'load' });

async function runVariant(name) {
  console.log(`\n=== variant ${name} ===`);
  // Reset logs.
  await page.evaluate(() => {
    document.getElementById('log').textContent = '';
    document.getElementById('opfs').textContent = '';
  });
  // Wipe OPFS first so each run is deterministic.
  await page.click('#wipe');
  await new Promise((r) => setTimeout(r, 300));
  await page.click(`#run-${name}`);
  // Wait until "worker result" appears or 60s timeout.
  const start = Date.now();
  for (;;) {
    const log = await page.$eval('#log', (el) => el.textContent);
    if (log.includes('worker result')) break;
    if (Date.now() - start > 90000) throw new Error('timeout waiting for variant');
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = await page.$eval('#log', (el) => el.textContent);
  const opfs = await page.$eval('#opfs', (el) => el.textContent);
  console.log('--- WORKER LOG ---\n' + log);
  console.log('--- OPFS READ-BACK ---\n' + opfs);
}

try {
  await runVariant('a');
  await runVariant('c');
} finally {
  await page.close();
  await browser.disconnect();
}
