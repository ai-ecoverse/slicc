import { chromium } from '@playwright/test';

const DEFAULT_CDP_PORT = 9222;

function resolveCdpPort(): number {
  const value = Number.parseInt(process.env['SLICC_E2E_CDP_PORT'] ?? '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : DEFAULT_CDP_PORT;
}

const cdpPort = resolveCdpPort();
const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${cdpPort}`],
});

console.log(`[e2e-cdp-browser] listening on ${cdpPort}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await browser.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

await new Promise<void>((resolve, reject) => {
  browser.once('disconnected', () => {
    if (stopping) resolve();
    else reject(new Error('Dedicated E2E CDP browser disconnected unexpectedly'));
  });
});
