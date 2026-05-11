/**
 * `realm-iframe.ts` — kernel-side adapter that wraps a per-task
 * sandbox iframe in the `Realm` interface used by `realm-runner`.
 *
 * Why an iframe (not a worker) for `kind:'js'` in the extension?
 * The extension's `manifest.json` declares
 * `script-src 'self' 'wasm-unsafe-eval'` for extension pages and
 * inherits that CSP into workers spawned from offscreen — blocking
 * `AsyncFunction(userCode)`. The sandbox pages
 * (`sandbox.html` etc.) run under their own lenient CSP and DO
 * allow `AsyncFunction`. Pyodide doesn't have this problem because
 * it interprets Python in WASM (only needs `wasm-unsafe-eval`).
 *
 * Per-task isolation: each invocation gets its own iframe + paired
 * `MessageChannel`. SIGKILL → `iframe.remove()` is synchronous and
 * uncatchable, mirroring `worker.terminate()` from the kernel's
 * point of view.
 *
 * Wire protocol (vs. legacy shared `data-js-tool` iframe):
 *   1. Parent creates iframe pointing at `sandbox.html` and a
 *      `MessageChannel` whose port1 stays on the parent.
 *   2. Parent waits for the iframe's `realm-iframe-ready` message
 *      (posted via `parent.postMessage` from inside the iframe
 *      after its bootstrap loads).
 *   3. Parent transfers port2 to the iframe via `iframe.contentWindow
 *      .postMessage({ type: 'realm-port-init' }, '*', [port2])`.
 *   4. Both sides talk over the port from then on; the parent's
 *      `controlPort` is `port1`.
 *
 * `terminate()` calls `iframe.remove()` to detach + free the
 * realm — synchronously kills the AsyncFunction running inside.
 */

import type { CommandContext } from 'just-bash';
import type { Realm } from './realm-runner.js';
import type { RealmKind } from './realm-types.js';

export interface RealmIframeOptions {
  /**
   * URL of the sandbox page that will host the realm. Defaults to
   * `chrome.runtime.getURL('sandbox.html')` in extension mode.
   */
  sandboxUrl?: string;
  /**
   * DOM container the iframe is appended to. Defaults to
   * `document.body`. Tests pass a JSDOM container.
   */
  container?: HTMLElement;
  /**
   * Hook that fires after the iframe element is created but before
   * it loads, so tests can stub out the iframe's contentWindow.
   * Production callers don't supply this.
   */
  onIframeCreated?: (iframe: HTMLIFrameElement) => void;
  /**
   * `MessageChannel` constructor. Defaults to the global. Tests
   * override to inject a fake.
   */
  messageChannelCtor?: typeof MessageChannel;
}

/**
 * Build a per-task iframe-backed `Realm`. Resolves once the iframe
 * has loaded and acknowledged the port. The `kind` argument is
 * accepted for API symmetry — the iframe code itself reads
 * `kind` from the `realm-init` message body, not from this
 * factory.
 */
export async function createIframeRealm(
  _kind: RealmKind,
  _ctx: CommandContext,
  options: RealmIframeOptions = {}
): Promise<Realm> {
  if (typeof document === 'undefined') {
    throw new Error('createIframeRealm: document is not available in this runtime');
  }
  const sandboxUrl = options.sandboxUrl ?? defaultSandboxUrl();
  if (!sandboxUrl) {
    throw new Error('createIframeRealm: sandbox URL not available (extension API missing)');
  }
  const container = options.container ?? document.body;
  const MCCtor = options.messageChannelCtor ?? globalThis.MessageChannel;
  if (typeof MCCtor !== 'function') {
    throw new Error('createIframeRealm: MessageChannel is not available');
  }

  const channel = new MCCtor();
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.dataset.realm = 'js';
  iframe.src = sandboxUrl;
  // Append BEFORE the test hook so callers that need to stub
  // `iframe.contentWindow.postMessage` (only available post-attach)
  // can do so on a live iframe.
  container.appendChild(iframe);
  options.onIframeCreated?.(iframe);

  // Wait for the iframe to post `realm-iframe-ready` from inside
  // its sandbox bootstrap. We listen on the parent window — the
  // iframe parented us so its postMessage targets this window.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', readyHandler);
      if (err) reject(err);
      else resolve();
    };
    const readyHandler = (event: MessageEvent): void => {
      // Only accept messages from this iframe's window.
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: string };
      if (data?.type !== 'realm-iframe-ready') return;
      // Hand over port2; the iframe wires it as its `controlPort`.
      iframe.contentWindow!.postMessage({ type: 'realm-port-init' }, '*', [channel.port2]);
      finish();
    };
    window.addEventListener('message', readyHandler);
    // If load fails outright the iframe never posts ready.
    iframe.addEventListener(
      'error',
      () => finish(new Error('realm-iframe: iframe failed to load')),
      { once: true }
    );
  });

  let terminated = false;
  return {
    controlPort: channel.port1,
    terminate(): void {
      if (terminated) return;
      terminated = true;
      try {
        iframe.remove();
      } catch {
        /* idempotent on JSDOM where remove can throw on detached nodes */
      }
      try {
        channel.port1.close();
      } catch {
        /* idempotent */
      }
    },
  };
}

function defaultSandboxUrl(): string | null {
  const c = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } }).chrome;
  if (c?.runtime?.getURL) return c.runtime.getURL('sandbox.html');
  return null;
}
