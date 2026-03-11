import { chromium } from 'playwright';
import http from 'http';

const SIGNAL_PORT = 3456;

// WebRTC page that runs in the browser
const WEBRTC_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Session Bridge</title></head>
<body>
<h3>WebRTC Session Bridge</h3>
<pre id="log"></pre>
<script>
const log = (msg) => {
  document.getElementById('log').textContent += msg + '\\n';
  console.log(msg);
};

let pc = null;
let dataChannel = null;
let onMessageCallback = null;

window.createOffer = async () => {
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  
  // Create data channel (offerer creates it)
  dataChannel = pc.createDataChannel('session');
  dataChannel.onopen = () => log('DataChannel open');
  dataChannel.onmessage = (e) => {
    log('Received: ' + e.data.substring(0, 100) + '...');
    if (onMessageCallback) onMessageCallback(e.data);
  };

  // Gather ICE candidates
  const candidates = [];
  pc.onicecandidate = (e) => {
    if (e.candidate) candidates.push(e.candidate);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') resolve();
    else pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
  });

  log('Offer created with ' + candidates.length + ' ICE candidates');
  return JSON.stringify({ sdp: pc.localDescription, candidates });
};

window.acceptOffer = async (offerJson) => {
  const { sdp, candidates } = JSON.parse(offerJson);
  
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  
  // Answer receives data channel
  pc.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.onopen = () => log('DataChannel open');
    dataChannel.onmessage = (e) => {
      log('Received: ' + e.data.substring(0, 100) + '...');
      if (onMessageCallback) onMessageCallback(e.data);
    };
  };

  await pc.setRemoteDescription(sdp);
  for (const c of candidates) await pc.addIceCandidate(c);

  const localCandidates = [];
  pc.onicecandidate = (e) => {
    if (e.candidate) localCandidates.push(e.candidate);
  };

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // Wait for ICE gathering
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') resolve();
    else pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
  });

  log('Answer created with ' + localCandidates.length + ' ICE candidates');
  return JSON.stringify({ sdp: pc.localDescription, candidates: localCandidates });
};

window.acceptAnswer = async (answerJson) => {
  const { sdp, candidates } = JSON.parse(answerJson);
  await pc.setRemoteDescription(sdp);
  for (const c of candidates) await pc.addIceCandidate(c);
  log('Answer accepted, connection establishing...');
};

window.sendMessage = (msg) => {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(msg);
    log('Sent: ' + msg.substring(0, 100) + '...');
    return true;
  }
  return false;
};

window.waitForMessage = () => {
  return new Promise(resolve => {
    onMessageCallback = (data) => {
      onMessageCallback = null;
      resolve(data);
    };
  });
};

window.isConnected = () => dataChannel && dataChannel.readyState === 'open';

log('WebRTC bridge ready');
</script>
</body>
</html>
`;

// ============== REMOTE MODE ==============
async function runRemote(initialUrl) {
  console.log('=== REMOTE MODE (WebRTC) ===\n');
  
  // Signal server for SDP exchange only
  let answerResolver;
  const answerPromise = new Promise(resolve => { answerResolver = resolve; });
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/answer') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200); res.end('OK');
        answerResolver(body);
      });
    } else {
      res.writeHead(200); res.end('ready');
    }
  });
  server.listen(SIGNAL_PORT);
  console.log(`[REMOTE] Signaling server on port ${SIGNAL_PORT}`);

  // Launch browser
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  
  // Open WebRTC bridge page
  const bridgePage = await context.newPage();
  await bridgePage.setContent(WEBRTC_PAGE);
  console.log('[REMOTE] WebRTC bridge page loaded');

  // Create offer
  const offer = await bridgePage.evaluate(() => window.createOffer());
  console.log('[REMOTE] WebRTC offer created');

  // Send offer to local peer (via signaling)
  console.log('[REMOTE] Waiting for local peer to connect...');
  await sendToLocal('/offer', offer);

  // Wait for answer
  const answer = await answerPromise;
  await bridgePage.evaluate((ans) => window.acceptAnswer(ans), answer);
  console.log('[REMOTE] WebRTC answer accepted');

  // Wait for connection
  await bridgePage.waitForFunction(() => window.isConnected(), { timeout: 30000 });
  console.log('[REMOTE] WebRTC DataChannel connected!\n');

  // Now navigate to target URL
  const page = await context.newPage();
  console.log(`[REMOTE] Navigating to: ${initialUrl}`);
  await page.goto(initialUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Check for login
  const hasLoginForm = await page.evaluate(() => {
    const el = document.querySelector('input[name="identifier"]');
    return el && el.offsetParent !== null;
  }).catch(() => false);

  if (hasLoginForm) {
    const oktaUrl = page.url();
    console.log(`[REMOTE] Login needed at: ${oktaUrl}`);
    
    // Request auth via WebRTC
    console.log('[REMOTE] Requesting auth via WebRTC...');
    await bridgePage.evaluate((url) => window.sendMessage(JSON.stringify({ type: 'auth-request', oktaUrl: url })), oktaUrl);

    // Wait for session via WebRTC
    console.log('[REMOTE] Waiting for session via WebRTC...');
    const sessionJson = await bridgePage.evaluate(() => window.waitForMessage());
    const session = JSON.parse(sessionJson);
    
    console.log(`[REMOTE] Received session with ${session.cookies.length} cookies`);
    
    // Apply session
    await context.addCookies(session.cookies);
    await page.goto(session.finalUrl, { waitUntil: 'networkidle' });
    
    const title = await page.title();
    console.log(`\n[REMOTE] === RESULT ===`);
    console.log(`[REMOTE] URL: ${page.url()}`);
    console.log(`[REMOTE] Title: ${title}`);
    console.log(`[REMOTE] SUCCESS!\n`);
  }

  console.log('[REMOTE] Close browser to exit.');
  await new Promise(r => browser.on('disconnected', r));
  server.close();
}

async function sendToLocal(path, data) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: SIGNAL_PORT + 1, path, method: 'POST' }, resolve);
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

// ============== LOCAL MODE ==============
async function runLocal() {
  console.log('=== LOCAL MODE (WebRTC) ===\n');
  
  let offerResolver;
  const offerPromise = new Promise(resolve => { offerResolver = resolve; });
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/offer') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200); res.end('OK');
        offerResolver(body);
      });
    } else {
      res.writeHead(200); res.end('ready');
    }
  });
  server.listen(SIGNAL_PORT + 1);
  console.log(`[LOCAL] Signaling server on port ${SIGNAL_PORT + 1}`);

  // Launch browser
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  
  // Open WebRTC bridge page
  const bridgePage = await context.newPage();
  await bridgePage.setContent(WEBRTC_PAGE);
  console.log('[LOCAL] WebRTC bridge page loaded');
  console.log('[LOCAL] Waiting for remote peer...\n');

  // Wait for offer
  const offer = await offerPromise;
  console.log('[LOCAL] Received WebRTC offer');
  
  // Create answer
  const answer = await bridgePage.evaluate((off) => window.acceptOffer(off), offer);
  console.log('[LOCAL] WebRTC answer created');
  
  // Send answer back
  await sendToRemote('/answer', answer);

  // Wait for connection
  await bridgePage.waitForFunction(() => window.isConnected(), { timeout: 30000 });
  console.log('[LOCAL] WebRTC DataChannel connected!\n');

  // Wait for auth request via WebRTC
  console.log('[LOCAL] Waiting for auth request via WebRTC...');
  const requestJson = await bridgePage.evaluate(() => window.waitForMessage());
  const { oktaUrl } = JSON.parse(requestJson);
  
  console.log(`[LOCAL] Auth requested for: ${oktaUrl}`);
  
  // Open login page
  const page = await context.newPage();
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.log(`[LOCAL] URL: ${frame.url()}`);
  });
  
  await page.goto(oktaUrl, { waitUntil: 'networkidle' });
  console.log('\n[LOCAL] *** Please log in ***\n');

  // Wait for login completion
  const startTime = Date.now();
  while (Date.now() - startTime < 5 * 60 * 1000) {
    if (!page.url().includes('okta.com')) {
      console.log(`[LOCAL] Left Okta!`);
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(2000);
  
  // Capture and send session via WebRTC
  const cookies = await context.cookies();
  const finalUrl = page.url();
  
  console.log(`[LOCAL] Sending session via WebRTC (${cookies.length} cookies)...`);
  await bridgePage.evaluate((data) => window.sendMessage(data), JSON.stringify({ cookies, finalUrl }));
  
  console.log('[LOCAL] Session sent! Done.');
  await browser.close();
  server.close();
}

async function sendToRemote(path, data) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: SIGNAL_PORT, path, method: 'POST' }, resolve);
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

// ============== MAIN ==============
const mode = process.argv[2];
const url = process.argv[3];

if (mode === 'remote') {
  runRemote(url || 'https://adobe.okta.com/app/UserHome').catch(console.error);
} else if (mode === 'local') {
  runLocal().catch(console.error);
} else {
  console.log('Usage:');
  console.log('  Terminal 1: node okta-webrtc.mjs remote <url>');
  console.log('  Terminal 2: node okta-webrtc.mjs local');
  console.log('\nSession data flows directly browser-to-browser via WebRTC DataChannel.');
  console.log('Node scripts only exchange initial SDP for signaling.');
}
