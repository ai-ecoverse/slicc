import { chromium } from 'playwright';
import * as fs from 'fs';

const OKTA_URL = 'https://adobe.okta.com/home/workday/0oaznv24p1XSFKINMULJ/30';

async function main() {
  console.log('=== Okta Session Transfer Experiment ===\n');

  // Launch LOCAL browser (headed so user can interact)
  // Use regular Chrome (not Chrome for Testing) for passkey support
  console.log('1. Launching LOCAL browser (regular Chrome for passkey support)...');
  const localBrowser = await chromium.launch({
    headless: false,
    channel: 'chrome',  // Use installed Chrome, not Chrome for Testing
    args: ['--start-maximized']
  });
  const localContext = await localBrowser.newContext({
    viewport: null // Use full window size
  });
  const localPage = await localContext.newPage();

  // Navigate to Okta
  console.log(`2. Navigating to: ${OKTA_URL}`);
  await localPage.goto(OKTA_URL, { waitUntil: 'networkidle' });

  console.log('\n*** Please complete the Okta login in the LOCAL browser ***');
  console.log('*** Waiting for redirect to Workday (non-okta URL)... ***\n');

  // Wait until we leave the Okta domain (indicating successful login + redirect)
  await localPage.waitForFunction(() => {
    return !window.location.hostname.includes('okta');
  }, { timeout: 300000 }); // 5 minute timeout
  
  // Give it a moment to fully load
  await localPage.waitForTimeout(3000);
  console.log('Login detected! Redirected away from Okta.');

  // Capture authentication state
  console.log('\n3. Capturing authentication state...');

  // Get cookies
  const cookies = await localContext.cookies();
  console.log(`   - Captured ${cookies.length} cookies`);

  // Get storage state (includes cookies, localStorage origins)
  const storageState = await localContext.storageState();
  
  // Also capture localStorage and sessionStorage from the page
  const localStorage = await localPage.evaluate(() => {
    const items = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      items[key] = window.localStorage.getItem(key);
    }
    return items;
  });

  const sessionStorage = await localPage.evaluate(() => {
    const items = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      items[key] = window.sessionStorage.getItem(key);
    }
    return items;
  });

  // Get current URL (might have changed after login)
  const finalUrl = localPage.url();
  console.log(`   - Final URL: ${finalUrl}`);
  console.log(`   - localStorage keys: ${Object.keys(localStorage).length}`);
  console.log(`   - sessionStorage keys: ${Object.keys(sessionStorage).length}`);

  // Save state to files for inspection
  const capturedState = {
    timestamp: new Date().toISOString(),
    finalUrl,
    cookies,
    storageState,
    localStorage,
    sessionStorage
  };

  fs.writeFileSync('okta-captured-state.json', JSON.stringify(capturedState, null, 2));
  console.log('   - Saved full state to okta-captured-state.json');

  // Print interesting cookies (Okta-related)
  console.log('\n4. Okta-related cookies:');
  const oktaCookies = cookies.filter(c => 
    c.domain.includes('okta') || 
    c.name.toLowerCase().includes('sid') ||
    c.name.toLowerCase().includes('token') ||
    c.name.toLowerCase().includes('auth') ||
    c.name.toLowerCase().includes('session')
  );
  
  for (const cookie of oktaCookies) {
    console.log(`   - ${cookie.name} (${cookie.domain})`);
    console.log(`     httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure}, expires: ${cookie.expires ? new Date(cookie.expires * 1000).toISOString() : 'session'}`);
  }

  console.log('\nLaunching REMOTE browser automatically...');

  // Launch REMOTE browser with captured state
  console.log('\n5. Launching REMOTE browser with captured authentication state...');
  const remoteBrowser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  // Create context with the captured storage state
  const remoteContext = await remoteBrowser.newContext({
    storageState: storageState,
    viewport: null
  });

  const remotePage = await remoteContext.newPage();

  // Also inject localStorage and sessionStorage
  await remotePage.addInitScript((storage) => {
    for (const [key, value] of Object.entries(storage.localStorage || {})) {
      window.localStorage.setItem(key, value);
    }
    for (const [key, value] of Object.entries(storage.sessionStorage || {})) {
      window.sessionStorage.setItem(key, value);
    }
  }, { localStorage, sessionStorage });

  // Navigate to the same URL
  console.log(`6. Navigating REMOTE browser to: ${finalUrl}`);
  await remotePage.goto(finalUrl, { waitUntil: 'networkidle' });

  console.log('\n*** Check if REMOTE browser is logged in ***');
  console.log('*** Both browsers should now be open ***\n');
  console.log('Keeping browsers open for 60 seconds for inspection...');
  
  await new Promise(resolve => setTimeout(resolve, 60000));

  // Cleanup
  await localBrowser.close();
  await remoteBrowser.close();

  console.log('\n=== Experiment complete ===');
  console.log('Check okta-captured-state.json for the full captured authentication state.');
}

main().catch(console.error);
