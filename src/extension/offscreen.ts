/**
 * Offscreen document entry point — bootstraps the SLICC agent engine.
 *
 * This runs in a Chrome offscreen document (long-lived extension page)
 * so the agent survives side panel close/reopen cycles.
 *
 * Initializes: Orchestrator, VFS, BrowserAPI (via CDP proxy), OffscreenBridge.
 */

import { BrowserAPI, OffscreenCdpProxy } from '../cdp/index.js';
import { Orchestrator } from '../scoops/index.js';
import { OffscreenBridge } from './offscreen-bridge.js';
import { createLogger } from '../core/index.js';

// Auto-discover and register all providers (built-in + external).
// IMPORTANT: Keep in sync with src/ui/main.ts — both entry points need all providers.
import '../providers/index.js';

const log = createLogger('offscreen');

// Use console.log directly for critical diagnostics (visible in chrome://extensions inspect)
console.log('[slicc-offscreen] Script loaded');

async function init(): Promise<void> {
  console.log('[slicc-offscreen] init() starting...');

  // Create CDP transport that proxies through the service worker
  const cdpProxy = new OffscreenCdpProxy();
  await cdpProxy.connect();
  console.log('[slicc-offscreen] CDP proxy connected');

  const browser = new BrowserAPI(cdpProxy);

  const container = document.body;

  const bridge = new OffscreenBridge();
  const callbacks = OffscreenBridge.createCallbacks(bridge);

  const orchestrator = new Orchestrator(
    container,
    {
      ...callbacks,
      getBrowserAPI: () => browser,
    },
  );

  // Bind the orchestrator to the bridge (sets up message listener + session store)
  // Pass BrowserAPI so the bridge can proxy panel CDP commands through the offscreen transport.
  await bridge.bind(orchestrator, browser);

  console.log('[slicc-offscreen] Orchestrator created, calling init()...');
  await orchestrator.init();
  console.log('[slicc-offscreen] Orchestrator initialized');

  // Ensure cone exists
  const allScoops = orchestrator.getScoops();
  const hasCone = allScoops.some(s => s.isCone);
  if (!hasCone) {
    await orchestrator.registerScoop({
      jid: `cone_${Date.now()}`,
      name: 'Cone',
      folder: 'cone',
      isCone: true,
      type: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: new Date().toISOString(),
    });
    console.log('[slicc-offscreen] Created cone');
  }

  // Signal readiness to any connected panels + send initial state
  chrome.runtime.sendMessage({
    source: 'offscreen' as const,
    payload: { type: 'offscreen-ready' },
  }).catch(() => { /* no panel yet */ });

  const snapshot = bridge.buildStateSnapshot();
  chrome.runtime.sendMessage({
    source: 'offscreen' as const,
    payload: snapshot,
  }).catch(() => { /* no panel yet */ });

  // Set up sprinkle manager proxy so the `sprinkle` shell command works from scoops.
  // The real SprinkleManager runs in the side panel (needs DOM). This proxy relays
  // operations via BroadcastChannel.
  const { createSprinkleManagerProxy } = await import('./sprinkle-proxy.js');
  (globalThis as unknown as Record<string, unknown>).__slicc_sprinkleManager = createSprinkleManagerProxy();

  console.log('[slicc-offscreen] Agent engine ready, scoops:', orchestrator.getScoops().length);
}

init().catch((err) => {
  console.error('[slicc-offscreen] Init FAILED:', err);
  log.error('Offscreen init failed', err);
});
