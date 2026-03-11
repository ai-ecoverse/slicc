import { chromium } from 'playwright';
import http from 'http';

const PORT = 3456;

// ============== REMOTE MODE ==============
// Chrome for Testing - requests auth from local peer

async function runRemote(initialUrl) {
  console.log('=== REMOTE MODE ===\n');
  
  // Start HTTP server to receive session from local peer
  let sessionResolver;
  const sessionPromise = new Promise(resolve => { sessionResolver = resolve; });
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        console.log('[REMOTE] Received session from local peer');
        res.writeHead(200);
        res.end('OK');
        sessionResolver(JSON.parse(body));
      });
    } else if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200);
      res.end('ready');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  server.listen(PORT, () => {
    console.log(`[REMOTE] Listening for session on port ${PORT}`);
  });

  // Launch browser
  console.log('[REMOTE] Launching Chrome for Testing...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // Navigate to initial URL
  console.log(`[REMOTE] Navigating to: ${initialUrl}`);
  await page.goto(initialUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Check if login needed
  const url = page.url();
  const hasLoginForm = await page.evaluate(() => {
    const el = document.querySelector('input[name="identifier"]');
    return el && el.offsetParent !== null;
  }).catch(() => false);

  if (hasLoginForm && url.includes('okta.com')) {
    console.log(`[REMOTE] Login form detected at: ${url}`);
    console.log('[REMOTE] Requesting auth from local peer...');
    
    // Signal local peer to authenticate
    await signalLocal(url);
    
    // Wait for session from local peer
    console.log('[REMOTE] Waiting for session from local peer...');
    const session = await sessionPromise;
    
    // Apply session
    console.log('[REMOTE] Applying received session...');
    await context.addCookies(session.cookies);
    
    // Navigate to final URL
    console.log(`[REMOTE] Navigating to: ${session.finalUrl}`);
    await page.goto(session.finalUrl, { waitUntil: 'networkidle' });
    
    // Verify
    const remoteUrl = page.url();
    const pageTitle = await page.title();
    const stillHasLogin = await page.evaluate(() => {
      const el = document.querySelector('input[name="identifier"]');
      return el && el.offsetParent !== null;
    }).catch(() => false);
    
    console.log(`\n[REMOTE] === RESULT ===`);
    console.log(`[REMOTE] URL: ${remoteUrl}`);
    console.log(`[REMOTE] Title: ${pageTitle}`);
    console.log(`[REMOTE] ${stillHasLogin ? 'FAIL: Still showing login' : 'SUCCESS: Authenticated!'}\n`);
  } else {
    console.log('[REMOTE] No login needed or already authenticated');
  }

  console.log('[REMOTE] Browser running. Close to exit.\n');
  
  await new Promise(resolve => {
    browser.on('disconnected', () => {
      console.log('[REMOTE] Browser closed.');
      server.close();
      resolve();
    });
  });
}

async function signalLocal(oktaUrl) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ oktaUrl });
    const req = http.request({
      hostname: 'localhost',
      port: PORT + 1,
      path: '/auth-request',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      resolve();
    });
    req.on('error', (err) => {
      console.log('[REMOTE] Warning: Could not signal local peer:', err.message);
      resolve(); // Continue anyway
    });
    req.write(data);
    req.end();
  });
}

// ============== LOCAL MODE ==============
// Regular Chrome - handles interactive login

async function runLocal() {
  console.log('=== LOCAL MODE ===\n');
  
  // Start HTTP server to receive auth requests from remote peer
  let authRequestResolver;
  let authRequestPromise = new Promise(resolve => { authRequestResolver = resolve; });
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/auth-request') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        console.log('[LOCAL] Received auth request from remote peer');
        res.writeHead(200);
        res.end('OK');
        authRequestResolver(JSON.parse(body));
      });
    } else if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200);
      res.end('ready');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  server.listen(PORT + 1, () => {
    console.log(`[LOCAL] Listening for auth requests on port ${PORT + 1}`);
  });

  console.log('[LOCAL] Waiting for auth request from remote peer...\n');
  
  // Wait for auth request
  const { oktaUrl } = await authRequestPromise;
  
  console.log(`[LOCAL] Auth requested for: ${oktaUrl}`);
  console.log('[LOCAL] Launching Chrome...');
  
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--start-maximized']
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // Log URL changes
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      console.log(`[LOCAL] URL: ${frame.url()}`);
    }
  });

  console.log(`[LOCAL] Navigating to: ${oktaUrl}`);
  await page.goto(oktaUrl, { waitUntil: 'networkidle' });

  console.log('\n[LOCAL] *** Please complete login ***');
  console.log('[LOCAL] *** Waiting for redirect away from Okta... ***\n');

  // Poll until we leave Okta
  const startTime = Date.now();
  const maxWait = 5 * 60 * 1000;
  
  while (Date.now() - startTime < maxWait) {
    const url = page.url();
    if (!url.includes('okta.com')) {
      console.log(`[LOCAL] Left Okta! Now at: ${url}`);
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (page.url().includes('okta.com')) {
    console.error('[LOCAL] Timeout waiting for login');
    await browser.close();
    server.close();
    return;
  }

  await page.waitForTimeout(2000);

  // Capture session
  const finalUrl = page.url();
  const cookies = await context.cookies();
  const storageState = await context.storageState();
  
  console.log(`[LOCAL] Login complete! Final URL: ${finalUrl}`);
  console.log(`[LOCAL] Captured ${cookies.length} cookies`);

  // Send session to remote peer
  console.log('[LOCAL] Sending session to remote peer...');
  await sendSessionToRemote({ finalUrl, cookies, storageState });
  
  console.log('[LOCAL] Session sent! Closing browser...');
  await browser.close();
  server.close();
  console.log('[LOCAL] Done.');
}

async function sendSessionToRemote(session) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(session);
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/session',
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      console.log('[LOCAL] Session delivery confirmed');
      resolve();
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============== MAIN ==============

const mode = process.argv[2];
const url = process.argv[3];

if (mode === 'remote') {
  if (!url) {
    console.error('Usage: node okta-p2p.mjs remote <url>');
    process.exit(1);
  }
  runRemote(url).catch(console.error);
} else if (mode === 'local') {
  runLocal().catch(console.error);
} else {
  console.log('Okta P2P Authentication Proxy\n');
  console.log('Usage:');
  console.log('  Terminal 1: node okta-p2p.mjs remote <url>');
  console.log('  Terminal 2: node okta-p2p.mjs local');
  console.log('\nThe remote browser will request auth from the local browser when needed.');
}
