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
      const mod = await import('@adobe/helix-rum-js');
      // Wrap helix's sampleRUM so its auto-registered error/unhandledrejection
      // listeners get the same Vite-noise filter and path collapse as direct
      // trackError calls. Without this, ~99% of CLI dev-mode error volume is
      // @vite/client HMR frames that drown out real app errors (issue #795).
      const helixSampleRUM = mod.sampleRUM as SampleRUM;
      sampleRUM = ((checkpoint, data) => {
        if (checkpoint === 'error' && typeof data?.target === 'string') {
          const sanitized = sanitizeError(data.target);
          if (sanitized === null) return;
          helixSampleRUM(checkpoint, { ...data, target: sanitized });
          return;
        }
        helixSampleRUM(checkpoint, data);
      }) as SampleRUM;
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
