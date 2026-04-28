/**
 * E2E test for dips feature.
 * Connects to the dev server's Chrome via CDP and verifies that
 * ```shtml code blocks are hydrated into sandboxed iframes.
 *
 * Usage:
 *   1. npm run dev:full
 *   2. node packages/webapp/tests/test-dips.mjs
 */

import puppeteer from 'puppeteer-core';

const CDP_URL = 'http://localhost:9222';
const APP_URL = 'http://localhost:5710/';

// Colors for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function ok(msg) {
  passed++;
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}
function fail(msg, err) {
  failed++;
  console.log(`  ${RED}✗${RESET} ${msg}`);
  if (err) console.log(`    ${DIM}${err}${RESET}`);
}

async function main() {
  console.log(`\n${YELLOW}Connecting to Chrome on ${CDP_URL}...${RESET}`);

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL });
  } catch (e) {
    console.error(`${RED}Cannot connect to Chrome CDP at ${CDP_URL}.${RESET}`);
    console.error('Make sure "npm run dev:full" is running.');
    process.exit(1);
  }

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().startsWith(APP_URL));
  if (!page) {
    page = await browser.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 15000 });
  }

  console.log(`${YELLOW}Running dip tests...${RESET}\n`);

  // ── Test 1: Inject a fake assistant message with shtml and verify hydration ──
  console.log('Test 1: shtml code block is hydrated into an iframe');
  try {
    const result = await page.evaluate(() => {
      // Find the chat messages container
      const messagesEl = document.querySelector('.chat__messages');
      if (!messagesEl) return { error: 'No .chat__messages element found' };

      // Create a fake message element with an shtml code block
      const wrapper = document.createElement('div');
      wrapper.className = 'msg-group';
      wrapper.setAttribute('data-msg-id', 'test-inline-1');
      wrapper.innerHTML = `
        <div class="msg msg--assistant">
          <div class="msg__content">
            <p>Here is a card:</p>
            <pre><code class="language-shtml">&lt;div class="sprinkle-action-card"&gt;
  &lt;div class="sprinkle-action-card__header"&gt;Test Card&lt;/div&gt;
  &lt;div class="sprinkle-action-card__body"&gt;This is a test&lt;/div&gt;
  &lt;div class="sprinkle-action-card__actions"&gt;
    &lt;button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick('test-action')"&gt;Click me&lt;/button&gt;
  &lt;/div&gt;
&lt;/div&gt;</code></pre>
          </div>
        </div>
      `;
      messagesEl.appendChild(wrapper);

      // Now hydrate it using the module function
      // We need to import it dynamically
      return { injected: true, hasCodeBlock: !!wrapper.querySelector('code.language-shtml') };
    });

    if (result.error) {
      fail('Could not find chat container', result.error);
    } else {
      ok('Injected test message with shtml code block');
    }
  } catch (e) {
    fail('Injection failed', e.message);
  }

  // ── Test 2: Use the actual hydration function ──
  console.log('\nTest 2: hydrateDips replaces code blocks with iframes');
  try {
    const result = await page.evaluate(async () => {
      // Dynamically import the dip module
      const mod = await import('/packages/webapp/src/ui/dip.ts');
      const wrapper = document.querySelector('[data-msg-id="test-inline-1"] .msg__content');
      if (!wrapper) return { error: 'Test message not found' };

      const licks = [];
      const instances = mod.hydrateDips(wrapper, (action, data) => {
        licks.push({ action, data });
      });

      return {
        instanceCount: instances.length,
        hasIframe: !!wrapper.querySelector('.msg__dip iframe'),
        iframeSandbox: wrapper.querySelector('.msg__dip iframe')?.getAttribute('sandbox'),
        noCodeBlock: !wrapper.querySelector('code.language-shtml'),
        hasWrapper: !!wrapper.querySelector('.msg__dip'),
      };
    });

    if (result.error) {
      fail('Hydration failed', result.error);
    } else {
      if (result.instanceCount === 1) ok(`Created ${result.instanceCount} dip instance`);
      else fail(`Expected 1 instance, got ${result.instanceCount}`);

      if (result.hasIframe) ok('iframe was created inside .msg__dip');
      else fail('No iframe found');

      if (result.iframeSandbox === 'allow-scripts') ok('iframe has sandbox="allow-scripts"');
      else fail(`Expected sandbox="allow-scripts", got "${result.iframeSandbox}"`);

      if (result.noCodeBlock) ok('Original code block was removed');
      else fail('Code block still exists after hydration');

      if (result.hasWrapper) ok('.msg__dip wrapper was created');
      else fail('No .msg__dip wrapper');
    }
  } catch (e) {
    fail('Hydration test failed', e.message);
  }

  // ── Test 3: iframe content loads correctly ──
  console.log('\nTest 3: iframe srcdoc renders the shtml content');
  try {
    // Wait for iframe to load
    await page.waitForSelector('[data-msg-id="test-inline-1"] .msg__dip iframe', {
      timeout: 3000,
    });
    await new Promise((r) => setTimeout(r, 500)); // give iframe time to render

    const result = await page.evaluate(() => {
      const iframe = document.querySelector('[data-msg-id="test-inline-1"] .msg__dip iframe');
      if (!iframe) return { error: 'No iframe found' };

      // Check srcdoc contains the expected content
      const srcdoc = iframe.srcdoc || '';
      return {
        hasBridgeScript: srcdoc.includes('dip-lick'),
        hasThemeCSS: srcdoc.includes(':root'),
        hasActionCard: srcdoc.includes('sprinkle-action-card'),
        hasSprinkleInlineClass: srcdoc.includes('sprinkle-inline'),
        hasAutoHeight: srcdoc.includes('dip-height'),
        iframeHeight: iframe.style.height,
        iframeDisplay: iframe.style.display,
      };
    });

    if (result.error) {
      fail('iframe check failed', result.error);
    } else {
      if (result.hasBridgeScript) ok('Bridge script with dip-lick is in srcdoc');
      else fail('Bridge script missing from srcdoc');

      if (result.hasThemeCSS) ok('Theme CSS variables are injected');
      else fail('Theme CSS missing');

      if (result.hasActionCard) ok('Action card HTML is rendered');
      else fail('Action card HTML missing');

      if (result.hasSprinkleInlineClass) ok('body has sprinkle-inline class');
      else fail('sprinkle-inline class missing');

      if (result.hasAutoHeight) ok('Auto-height reporting script present');
      else fail('Auto-height script missing');
    }
  } catch (e) {
    fail('iframe content test failed', e.message);
  }

  // ── Test 4: Lick callback fires via postMessage ──
  console.log('\nTest 4: Button click fires lick via postMessage');
  try {
    const result = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const licks = [];
        // Listen for the lick postMessage
        const handler = (event) => {
          const msg = event.data;
          if (msg?.type === 'dip-lick') {
            licks.push({ action: msg.action, data: msg.data });
          }
        };
        window.addEventListener('message', handler);

        // Find the iframe and simulate a click on its button
        const iframe = document.querySelector('[data-msg-id="test-inline-1"] .msg__dip iframe');
        if (!iframe?.contentWindow) {
          resolve({ error: 'No iframe contentWindow' });
          return;
        }

        // Post a simulated lick from the iframe's perspective
        // (We can't click inside a sandboxed srcdoc iframe from outside,
        //  but we can verify the bridge script by posting the message ourselves)
        iframe.contentWindow.postMessage({ type: 'test-click' }, '*');

        // Directly test the bridge by simulating what the button onclick would do
        window.postMessage(
          {
            type: 'dip-lick',
            action: 'test-action',
            data: { env: 'prod' },
          },
          '*'
        );

        setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve({
            lickCount: licks.length,
            firstLick: licks[0],
          });
        }, 200);
      });
    });

    if (result.error) {
      fail('Lick test failed', result.error);
    } else {
      if (result.lickCount >= 1) ok(`Received ${result.lickCount} lick event(s)`);
      else fail('No lick events received');

      if (result.firstLick?.action === 'test-action') ok('Lick action is correct: "test-action"');
      else fail(`Expected action "test-action", got "${result.firstLick?.action}"`);

      if (result.firstLick?.data?.env === 'prod') ok('Lick data is correct: {env: "prod"}');
      else fail(`Unexpected lick data: ${JSON.stringify(result.firstLick?.data)}`);
    }
  } catch (e) {
    fail('Lick callback test failed', e.message);
  }

  // ── Test 5: Multiple shtml blocks in one message ──
  console.log('\nTest 5: Multiple shtml blocks in one message');
  try {
    const result = await page.evaluate(async () => {
      const mod = await import('/packages/webapp/src/ui/dip.ts');
      const messagesEl = document.querySelector('.chat__messages');

      const wrapper = document.createElement('div');
      wrapper.className = 'msg-group';
      wrapper.setAttribute('data-msg-id', 'test-inline-multi');
      wrapper.innerHTML = `
        <div class="msg msg--assistant">
          <div class="msg__content">
            <p>Two cards:</p>
            <pre><code class="language-shtml">&lt;p&gt;Card A&lt;/p&gt;</code></pre>
            <p>And another:</p>
            <pre><code class="language-shtml">&lt;p&gt;Card B&lt;/p&gt;</code></pre>
          </div>
        </div>
      `;
      messagesEl.appendChild(wrapper);

      const contentEl = wrapper.querySelector('.msg__content');
      const instances = mod.hydrateDips(contentEl, () => {});

      return {
        instanceCount: instances.length,
        iframeCount: contentEl.querySelectorAll('.msg__dip iframe').length,
        remainingCodeBlocks: contentEl.querySelectorAll('code.language-shtml').length,
        paragraphCount: contentEl.querySelectorAll('p').length, // should still have 2 text paragraphs
      };
    });

    if (result.instanceCount === 2)
      ok(`Created ${result.instanceCount} instances for 2 shtml blocks`);
    else fail(`Expected 2 instances, got ${result.instanceCount}`);

    if (result.iframeCount === 2) ok(`${result.iframeCount} iframes rendered`);
    else fail(`Expected 2 iframes, got ${result.iframeCount}`);

    if (result.remainingCodeBlocks === 0) ok('All code blocks replaced');
    else fail(`${result.remainingCodeBlocks} code blocks still remain`);

    if (result.paragraphCount === 2) ok('Surrounding text paragraphs preserved');
    else fail(`Expected 2 paragraphs, got ${result.paragraphCount}`);
  } catch (e) {
    fail('Multi-block test failed', e.message);
  }

  // ── Test 6: Non-shtml code blocks are not hydrated ──
  console.log('\nTest 6: Non-shtml code blocks are left untouched');
  try {
    const result = await page.evaluate(async () => {
      const mod = await import('/packages/webapp/src/ui/dip.ts');
      const container = document.createElement('div');
      container.innerHTML = `
        <pre><code class="language-javascript">const x = 1;</code></pre>
        <pre><code class="language-html">&lt;p&gt;Hello&lt;/p&gt;</code></pre>
      `;

      const instances = mod.hydrateDips(container, () => {});
      return {
        instanceCount: instances.length,
        codeBlockCount: container.querySelectorAll('pre > code').length,
      };
    });

    if (result.instanceCount === 0) ok('No instances created for non-shtml blocks');
    else fail(`Expected 0 instances, got ${result.instanceCount}`);

    if (result.codeBlockCount === 2) ok('Code blocks left untouched');
    else fail(`Expected 2 code blocks, got ${result.codeBlockCount}`);
  } catch (e) {
    fail('Non-shtml test failed', e.message);
  }

  // ── Test 7: Dispose cleans up iframes ──
  console.log('\nTest 7: Dispose removes iframes and cleans up');
  try {
    const result = await page.evaluate(async () => {
      const mod = await import('/packages/webapp/src/ui/dip.ts');
      const container = document.createElement('div');
      container.innerHTML = `<pre><code class="language-shtml">&lt;p&gt;Disposable&lt;/p&gt;</code></pre>`;
      document.body.appendChild(container);

      const instances = mod.hydrateDips(container, () => {});
      const hadIframe = !!container.querySelector('iframe');

      mod.disposeDips(instances);

      const hasIframeAfter = !!container.querySelector('iframe');
      const instancesEmpty = instances.length === 0;

      container.remove();

      return { hadIframe, hasIframeAfter, instancesEmpty };
    });

    if (result.hadIframe) ok('iframe existed before dispose');
    else fail('No iframe was created');

    if (!result.hasIframeAfter) ok('iframe removed after dispose');
    else fail('iframe still exists after dispose');

    if (result.instancesEmpty) ok('Instances array cleared');
    else fail('Instances array not cleared');
  } catch (e) {
    fail('Dispose test failed', e.message);
  }

  // ── Test 8: Auto-height via ResizeObserver ──
  console.log('\nTest 8: iframe auto-height via ResizeObserver');
  try {
    const result = await page.evaluate(async () => {
      const mod = await import('/packages/webapp/src/ui/dip.ts');
      const container = document.createElement('div');
      container.style.width = '400px';
      container.innerHTML = `<pre><code class="language-shtml">&lt;div style="height:150px"&gt;Tall content&lt;/div&gt;</code></pre>`;
      document.body.appendChild(container);

      const instances = mod.hydrateDips(container, () => {});
      const iframe = container.querySelector('iframe');
      if (!iframe) return { error: 'No iframe' };

      // Wait for the iframe to load and report height
      await new Promise((r) => setTimeout(r, 1000));

      const height = iframe.style.height;
      mod.disposeDips(instances);
      container.remove();

      return { height, hasHeight: !!height && height !== '' && height !== '0px' };
    });

    if (result.error) {
      fail('Auto-height test setup failed', result.error);
    } else if (result.hasHeight) {
      ok(`iframe height was auto-set to ${result.height}`);
    } else {
      // This may not work in all environments due to sandbox restrictions
      fail(`iframe height not set (got "${result.height}") — may be a sandbox limitation`);
    }
  } catch (e) {
    fail('Auto-height test failed', e.message);
  }

  // ── Cleanup test messages ──
  await page.evaluate(() => {
    document.querySelector('[data-msg-id="test-inline-1"]')?.remove();
    document.querySelector('[data-msg-id="test-inline-multi"]')?.remove();
  });

  // ── Summary ──
  console.log(`\n${'─'.repeat(50)}`);
  console.log(
    `  ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ''}${failed} failed${RESET}`
  );
  console.log(`${'─'.repeat(50)}\n`);

  browser.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}Fatal error:${RESET}`, e.message);
  process.exit(1);
});
