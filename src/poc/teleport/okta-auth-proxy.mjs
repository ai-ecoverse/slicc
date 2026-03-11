import { chromium } from 'playwright';
import * as fs from 'fs';

const STATE_FILE = 'okta-session-state.json';

class OktaAuthProxy {
  constructor() {
    this.remoteBrowser = null;
    this.remoteContext = null;
    this.remotePage = null;
    this.authLock = false;  // Synchronous lock
    this.checkPending = false;
  }

  async start(initialUrl) {
    console.log('=== Okta Auth Proxy ===\n');

    // Load existing session state if available
    let storageState = null;
    if (fs.existsSync(STATE_FILE)) {
      console.log('Loading existing session state...');
      storageState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).storageState;
    }

    // Launch REMOTE browser (Chrome for Testing - automation-friendly)
    console.log('Launching REMOTE browser (Chrome for Testing)...');
    this.remoteBrowser = await chromium.launch({
      headless: false,
      args: ['--start-maximized']
    });

    this.remoteContext = await this.remoteBrowser.newContext({
      viewport: null,
      storageState: storageState || undefined
    });

    this.remotePage = await this.remoteContext.newPage();
    this.attachListeners();

    console.log('\n*** Remote browser is running ***');
    console.log('*** When Okta login is needed, a local browser will open ***\n');

    // Navigate to initial URL
    if (initialUrl) {
      console.log(`Navigating to: ${initialUrl}`);
      await this.remotePage.goto(initialUrl, { waitUntil: 'networkidle' });
      console.log(`Page loaded. Current URL: ${this.remotePage.url()}`);
      await this.remotePage.waitForTimeout(2000);
      this.scheduleCheck();
    }

    console.log('\nProxy active. Close the browser to exit.\n');
    await this.waitForClose();
  }

  attachListeners() {
    // Debounced check on navigation
    this.remotePage.on('framenavigated', (frame) => {
      if (frame === this.remotePage.mainFrame()) {
        this.scheduleCheck();
      }
    });
  }

  scheduleCheck() {
    // Debounce: only one check at a time
    if (this.checkPending || this.authLock) return;
    this.checkPending = true;
    
    setTimeout(async () => {
      this.checkPending = false;
      if (!this.authLock) {
        await this.checkForOktaLogin();
      }
    }, 1500); // Wait for page to settle
  }

  async checkForOktaLogin() {
    if (this.authLock) return;

    const url = this.remotePage.url();
    if (!url.includes('okta.com')) return;

    // Check for login form in DOM
    const hasLoginForm = await this.remotePage.evaluate(() => {
      const el = document.querySelector('input[name="identifier"]');
      return el && el.offsetParent !== null;
    }).catch(() => false);

    if (hasLoginForm) {
      console.log(`\n>>> Login form detected at: ${url}`);
      // Set lock SYNCHRONOUSLY before any async work
      this.authLock = true;
      await this.performInteractiveLogin(url);
    }
  }

  async performInteractiveLogin(oktaUrl) {
    console.log('\n=== Opening LOCAL browser for authentication ===\n');

    const localBrowser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--start-maximized']
    });

    const localContext = await localBrowser.newContext({ viewport: null });
    const localPage = await localContext.newPage();

    console.log(`Navigating to: ${oktaUrl}`);
    await localPage.goto(oktaUrl, { waitUntil: 'networkidle' });

    // Log all URL changes in local browser
    localPage.on('framenavigated', (frame) => {
      if (frame === localPage.mainFrame()) {
        console.log(`[LOCAL] URL changed to: ${frame.url()}`);
      }
    });

    console.log('\n*** Please log in. Waiting for redirect away from Okta... ***\n');
    console.log('(5 minute timeout)\n');

    try {
      // Wait until we leave Okta entirely (URL-based detection)
      // Use polling instead of waitForFunction to avoid timeout issues
      const startTime = Date.now();
      const maxWait = 5 * 60 * 1000; // 5 minutes
      
      while (Date.now() - startTime < maxWait) {
        const url = localPage.url();
        const leftOkta = !url.includes('okta.com');
        
        if (leftOkta) {
          console.log(`[LOCAL] Left Okta! Now at: ${url}`);
          break;
        }
        
        await localPage.waitForTimeout(1000);
      }
      
      if (localPage.url().includes('okta.com')) {
        throw new Error('Timeout waiting for login completion');
      }

      await localPage.waitForTimeout(2000);

      const finalUrl = localPage.url();
      console.log(`Login complete! Final URL: ${finalUrl}`);

      // Capture session
      const storageState = await localContext.storageState();
      const cookies = await localContext.cookies();

      fs.writeFileSync(STATE_FILE, JSON.stringify({
        timestamp: new Date().toISOString(),
        finalUrl,
        cookies,
        storageState
      }, null, 2));
      console.log('Session saved.');

      await localBrowser.close();
      console.log('Local browser closed.');

      // Apply cookies to existing remote context (no new window)
      console.log('Applying session to remote browser...');
      await this.remoteContext.addCookies(cookies);
      
      // Navigate existing page to final URL
      console.log(`Navigating remote to: ${finalUrl}`);
      await this.remotePage.goto(finalUrl, { waitUntil: 'networkidle' });
      
      // Verify remote browser state
      const remoteUrl = this.remotePage.url();
      const pageTitle = await this.remotePage.title();
      console.log(`\n*** Session transferred! ***`);
      console.log(`[REMOTE] Final URL: ${remoteUrl}`);
      console.log(`[REMOTE] Page title: ${pageTitle}`);
      
      // Check if we're still on a login page
      const hasLoginForm = await this.remotePage.evaluate(() => {
        const el = document.querySelector('input[name="identifier"]');
        return el && el.offsetParent !== null;
      }).catch(() => false);
      
      if (hasLoginForm) {
        console.log(`[REMOTE] WARNING: Still showing login form!`);
      } else {
        console.log(`[REMOTE] SUCCESS: No login form detected - authenticated!`);
      }
      console.log('');

    } catch (error) {
      console.error('Login failed:', error.message);
      await localBrowser.close();
    }

    // Release lock after everything is done
    this.authLock = false;
  }

  async waitForClose() {
    return new Promise((resolve) => {
      this.remoteBrowser.on('disconnected', () => {
        console.log('\nBrowser closed. Exiting.');
        resolve();
      });
    });
  }
}

const proxy = new OktaAuthProxy();
const url = process.argv[2] || 'https://adobe.okta.com/app/UserHome';
proxy.start(url).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Keep process alive
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
