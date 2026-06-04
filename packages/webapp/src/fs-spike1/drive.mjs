// Spike 1 — driver. Opens the spike URL in the running Chrome (CDP 9222),
// waits for `window.__spike1Result` to appear, prints the JSON, and closes
// the tab. THROWAWAY.
import puppeteer from 'puppeteer-core';

const URL = process.env.SPIKE_URL ?? 'http://127.0.0.1:5733/packages/webapp/fs-spike1.html?clone=1';
const CDP = process.env.SPIKE_CDP ?? 'http://127.0.0.1:9222';

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (msg) => {
  consoleLines.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => {
  consoleLines.push(`[pageerror] ${err.message}`);
});

await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });

// Poll for window.__spike1Result up to 180s.
const deadline = Date.now() + 180_000;
let result = null;
while (Date.now() < deadline) {
  result = await page.evaluate(() => /** @type {any} */ (globalThis).__spike1Result ?? null);
  if (result) break;
  await new Promise((r) => setTimeout(r, 1000));
}

if (!result) {
  console.error('TIMEOUT — no window.__spike1Result after 180s');
  console.error('\n--- console ---');
  for (const line of consoleLines) console.error(line);
  await page.close();
  await browser.disconnect();
  process.exit(2);
}

console.log(JSON.stringify(result, null, 2));
console.error('\n--- console ---');
for (const line of consoleLines) console.error(line);
await page.close();
await browser.disconnect();
