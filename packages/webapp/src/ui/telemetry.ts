/**
 * Operational telemetry module using @adobe/helix-rum-js.
 * See docs/operational-telemetry.md for design details.
 *
 * Uses supported helix-rum checkpoints with SLICC-specific semantics:
 * - formsubmit: user chat message sent
 * - fill: shell command executed
 * - viewblock: sprinkle displayed
 * - viewmedia: image preview (in chat or via open --view)
 * - error: JS errors or LLM errors
 * - signup: settings dialog opened
 * - navigate: page load with deployment mode
 */

import { setAgentErrorTelemetrySink } from '../core/telemetry-hook.js';
import { type ScoopLifecycleEvent, setScoopTelemetrySink } from '../scoops/scoop-telemetry-hook.js';
import { setShellTelemetrySink } from '../shell/telemetry-hook.js';

type SampleRUM = (checkpoint: string, data?: { source?: string; target?: string }) => void;

let sampleRUM: SampleRUM | null = null;
let initialized = false;

declare global {
  interface Window {
    SAMPLE_PAGEVIEWS_AT_RATE?: string;
    RUM_BASE?: string;
    RUM_GENERATION?: string;
  }
}

/**
 * Get the deployment mode label for telemetry. `standalone-worker` covers
 * the standalone kernel-worker DedicatedWorker (no `window`), distinguishing
 * it from the page-side standalone shell.
 */
function getModeLabel(): 'cli' | 'extension' | 'electron' | 'standalone-worker' {
  // Workers have no `window`. `chrome` / `document` / `localStorage` are
  // also unavailable, so this check has to come first.
  if (typeof window === 'undefined') return 'standalone-worker';
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) return 'extension';
  if (typeof document !== 'undefined' && document.documentElement?.dataset?.electronOverlay)
    return 'electron';
  return 'cli';
}

/**
 * Initialize operational telemetry. Call once from each host's boot:
 * `ui/main.ts` (page-side standalone / electron / extension panel),
 * `chrome-extension/src/offscreen.ts` (extension agent realm), and
 * `kernel/kernel-worker.ts` (standalone agent realm).
 *
 * In worker contexts (`standalone-worker`) the inlined `rum.js` is replaced
 * by `rum-worker.js`, error listeners are registered on `self` instead of
 * `window`, and the `RUM_GENERATION` / `SAMPLE_PAGEVIEWS_AT_RATE` writes
 * are gated on `typeof window !== 'undefined'`.
 *
 * No-op if telemetry is disabled via localStorage toggle.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('telemetry-disabled') === 'true')
    return;

  // Register the shell telemetry sink so the worker-resident shell can emit
  // command beacons without importing this DOM-bound module (dependency
  // inversion — keeps the shell layer free of a back-edge into ui/).
  setShellTelemetrySink(trackShellCommand);

  // Same dependency-inversion pattern for scoop lifecycle events
  // (spawn / feed / complete / error). The orchestrator runs in the
  // kernel worker / offscreen agent realm and never imports this module
  // directly.
  setScoopTelemetrySink(trackScoopLifecycle);

  // Register the agent-error telemetry sink (same dependency-inversion
  // pattern) so LLM stream failures and tool execution errors in
  // `scoops/scoop-context.ts` reach `trackError` with the correct typed
  // source ('llm' / 'tool') instead of being lost or mislabeled as 'js'.
  setAgentErrorTelemetrySink(trackError);

  try {
    const mode = getModeLabel();

    if (typeof window !== 'undefined') {
      window.RUM_GENERATION = `slicc-${mode}`;
    } else {
      // Worker realm: no Window, but rum-worker.js reads `globalThis.RUM_GENERATION`.
      (globalThis as Record<string, unknown>).RUM_GENERATION = `slicc-${mode}`;
    }

    if (mode === 'standalone-worker') {
      // Worker realm: helix-rum-js touches `document.currentScript` and
      // `window.location` which don't exist in a DedicatedWorker. Use the
      // worker-safe inlined sampler and register error listeners on `self`.
      const mod = await import('./rum-worker.js');
      sampleRUM = mod.default as SampleRUM;
      self.addEventListener('error', (e) => {
        trackError('js', (e as ErrorEvent).message ?? '');
      });
      self.addEventListener('unhandledrejection', (e) => {
        const reason = (e as PromiseRejectionEvent).reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        trackError('js', msg);
      });
    } else if (mode === 'extension') {
      const mod = await import('./rum.js');
      sampleRUM = mod.default as SampleRUM;

      // Helix-rum-js auto-registers its own error/unhandledrejection listeners
      // for selected sessions. The inlined rum.js does not — register equivalents
      // here so the extension panel still records JS errors. Do NOT add these to
      // the CLI/Electron branch (would double-fire alongside helix's listeners).
      // trackError applies sanitizeError internally so Vite/path filtering is
      // shared with the CLI sampleRUM wrapper below.
      if (typeof window !== 'undefined') {
        window.addEventListener('error', (e) => {
          trackError('js', (e as ErrorEvent).message ?? '');
        });
        window.addEventListener('unhandledrejection', (e) => {
          const reason = (e as PromiseRejectionEvent).reason;
          const msg = reason instanceof Error ? reason.message : String(reason);
          trackError('js', msg);
        });
      }
    } else {
      // CLI / Electron — use @adobe/helix-rum-js with its auto-loaded enhancer
      // (CWV, auto-click). The extension can't load the enhancer at runtime
      // because the manifest CSP blocks external script loads, which is why
      // the extension branch above uses the inlined rum.js instead.
      if (typeof window !== 'undefined') {
        window.SAMPLE_PAGEVIEWS_AT_RATE = 'high';
      }
      // Wrap navigator.sendBeacon BEFORE importing @adobe/helix-rum-js. Helix
      // auto-registers its own window.error / unhandledrejection listeners that
      // resolve `sampleRUM` via lexical closure to its internal function
      // declaration, bypassing any wrapper we put on the exported binding.
      // The beacon path is the only chokepoint we can intercept from the
      // outside, so we filter Vite-noise error checkpoints there. Without this,
      // ~99% of CLI dev-mode error volume is @vite/client HMR frames that drown
      // out real app errors (issue #795). Same-origin bodies (helix sends a
      // Blob when sampleRUM.collectBaseURL shares window.location.origin) are
      // passed through unchanged — the default rum.hlx.page endpoint is always
      // cross-origin so the body is a plain JSON string in practice. The
      // wrapper is intentionally not restored on teardown: there is no
      // disposeTelemetry helper, and CLI / Electron pages live for the session.
      wrapSendBeaconForViteFilter();
      const mod = await import('@adobe/helix-rum-js');
      sampleRUM = mod.sampleRUM as SampleRUM;
    }

    initialized = true;

    if (sampleRUM) {
      sampleRUM('navigate', {
        source: typeof document !== 'undefined' ? document.referrer : '',
        target: mode,
      });
    }
  } catch {
    // Telemetry init must never block the UI
  }
}

/** User sent a chat message. source=scoop name, target=model */
export function trackChatSend(scoopName: string, model: string): void {
  sampleRUM?.('formsubmit', { source: scoopName, target: model });
}

/** Shell command executed. source=command name */
export function trackShellCommand(commandName: string): void {
  sampleRUM?.('fill', { source: commandName });
}

/** Sprinkle displayed. source=sprinkle name */
export function trackSprinkleView(sprinkleName: string): void {
  sampleRUM?.('viewblock', { source: sprinkleName });
}

/** Image viewed (in chat or via open --view). source=context (chat/preview) */
export function trackImageView(context: string): void {
  sampleRUM?.('viewmedia', { source: context });
}

/** Error occurred. source=error type (js/llm/tool), target=details */
export function trackError(errorType: string, details?: string): void {
  let target = details;
  if (typeof target === 'string') {
    const sanitized = sanitizeError(target);
    if (sanitized === null) return;
    target = sanitized;
  }
  sampleRUM?.('error', { source: errorType, target });
}

/** Settings dialog opened. source=trigger (button/shortcut) */
export function trackSettingsOpen(trigger: string): void {
  sampleRUM?.('signup', { source: trigger });
}

/**
 * Map a scoop lifecycle event to a helix-rum checkpoint. Used as the
 * sink registered with `setScoopTelemetrySink` during `initTelemetry`.
 *
 * Checkpoint mapping (consistent with the module's reuse of helix-rum
 * checkpoints for SLICC-specific semantics):
 * - spawn    → `enter`   (a new scoop joined the orchestrator)
 * - feed     → `convert` (the cone delegated work to a scoop)
 * - complete → `leave`   (a scoop finished a turn with output)
 * - error    → `error`   (fatal or non-fatal scoop failure)
 *
 * `source` always carries the scoop folder so RUM filtering by scoop
 * name works for every checkpoint. The `error` branch runs the details
 * through `sanitizeError` so Vite-dev-server noise and VFS paths are
 * collapsed the same way they are for `trackError`.
 */
export function trackScoopLifecycle(
  event: ScoopLifecycleEvent,
  scoopName: string,
  details?: string
): void {
  if (event === 'error') {
    let target: string | undefined = details;
    if (typeof target === 'string') {
      const sanitized = sanitizeError(target);
      if (sanitized === null) return;
      target = sanitized;
    }
    sampleRUM?.('error', { source: `scoop:${scoopName}`, target });
    return;
  }
  const checkpoint = event === 'spawn' ? 'enter' : event === 'feed' ? 'convert' : 'leave';
  sampleRUM?.(checkpoint, { source: scoopName, target: `scoop-${event}` });
}

/**
 * Reduce error messages to a privacy-safe form, and drop Vite dev-server noise.
 * - Strip frames originating from Vite's HMR client (@vite/client, @vite/env,
 *   localhost:<port>/@vite/*, [vite] tags, /__vite_ping pings). In CLI dev
 *   mode these dominate error volume (~99% per issue #795) and obscure real
 *   app errors. Return `null` if the entire message is Vite noise so callers
 *   can skip emitting the error checkpoint entirely.
 * - Truncate to 200 characters.
 * - Collapse VFS-style paths (/<root>/...) past their first segment to /<root>/.../
 *   so `/workspace/skills/foo/bar.ts` becomes `/workspace/.../`.
 *   The regex uses the `i` flag, so `/Workspace/...` and `/SHARED/...` collapse too.
 */
function isViteDevFrame(line: string): boolean {
  return (
    line.includes('@vite/client') ||
    line.includes('@vite/env') ||
    line.includes('[vite]') ||
    /https?:\/\/localhost:\d+\/@vite\//.test(line) ||
    /\/__vite_ping/.test(line)
  );
}

function sanitizeError(msg: string): string | null {
  const raw = msg ?? '';

  if (raw.includes('@vite/') || raw.includes('[vite]') || raw.includes('__vite_ping')) {
    const kept = raw.split('\n').filter((line) => !isViteDevFrame(line));
    const cleaned = kept.join('\n').trim();
    if (!cleaned) return null;
    return cleaned.slice(0, 200).replace(/(\/[a-z]+)(?:\/[^\s/]+)+/gi, '$1/.../');
  }

  const truncated = raw.slice(0, 200);
  return truncated.replace(/(\/[a-z]+)(?:\/[^\s/]+)+/gi, '$1/.../');
}

/**
 * Sentinel marker so a re-init (or a second helix-rum-js import) doesn't wrap
 * an already-wrapped sendBeacon and build up a recursive chain.
 */
const SENDBEACON_WRAPPED = Symbol.for('slicc.telemetry.sendBeacon.wrapped');

/**
 * Wrap `navigator.sendBeacon` so error beacons emitted by helix-rum-js's
 * internal listeners (which we cannot intercept at the sampleRUM seam) are
 * filtered through sanitizeError. Vite-noise-only beacons are dropped and a
 * mixed beacon is rewritten with a sanitized `target`. Non-error checkpoints
 * pass through untouched. Opaque (Blob/ArrayBufferView) bodies are passed
 * through unchanged — sendBeacon is sync and Blob.text() is async.
 */
function wrapSendBeaconForViteFilter(): void {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  const current = navigator.sendBeacon as typeof navigator.sendBeacon & {
    [SENDBEACON_WRAPPED]?: boolean;
  };
  if (current[SENDBEACON_WRAPPED]) return;
  const original = current.bind(navigator);
  const wrapped = ((url, data) => {
    try {
      const text =
        typeof data === 'string'
          ? data
          : data instanceof ArrayBuffer
            ? new TextDecoder().decode(data)
            : null;
      if (text && text.length > 0 && text.charCodeAt(0) === 123 /* '{' */) {
        const parsed = JSON.parse(text) as { checkpoint?: string; target?: unknown };
        if (parsed?.checkpoint === 'error' && typeof parsed.target === 'string') {
          const sanitized = sanitizeError(parsed.target);
          if (sanitized === null) return true;
          if (sanitized !== parsed.target) {
            parsed.target = sanitized;
            return original(url, JSON.stringify(parsed));
          }
        }
      }
    } catch {
      // Opaque or non-JSON body — fall through and send as-is.
    }
    return original(url, data);
  }) as typeof navigator.sendBeacon & { [SENDBEACON_WRAPPED]?: boolean };
  wrapped[SENDBEACON_WRAPPED] = true;
  navigator.sendBeacon = wrapped;
}

/**
 * Check if telemetry is enabled.
 */
export function isTelemetryEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem('telemetry-disabled') !== 'true';
}

/**
 * Enable or disable telemetry. Takes effect on next page load.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (enabled) {
    localStorage.removeItem('telemetry-disabled');
  } else {
    localStorage.setItem('telemetry-disabled', 'true');
  }
}
