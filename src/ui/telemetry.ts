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
 * Get the deployment mode label for telemetry.
 */
function getModeLabel(): 'cli' | 'extension' | 'electron' {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) return 'extension';
  if (typeof document !== 'undefined' && document.documentElement?.dataset?.electronOverlay)
    return 'electron';
  return 'cli';
}

/**
 * Initialize operational telemetry. Call once from main.ts.
 * No-op if telemetry is disabled via localStorage toggle.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('telemetry-disabled') === 'true')
    return;

  // Extension mode: require explicit consent before sending any RUM data
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  if (isExtension) {
    const consent = localStorage.getItem('telemetry-consent');
    if (consent !== 'granted') return;
  }

  try {
    // High sampling rate (1-in-10) for beta. Remove for GA (defaults to 1-in-100).
    if (typeof window !== 'undefined') {
      window.SAMPLE_PAGEVIEWS_AT_RATE = 'high';
    }

    const mod = await import('@adobe/helix-rum-js');
    sampleRUM = mod.sampleRUM;
    initialized = true;

    if (sampleRUM) {
      sampleRUM('navigate', {
        source: typeof document !== 'undefined' ? document.referrer : '',
        target: getModeLabel(),
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
  sampleRUM?.('error', { source: errorType, target: details });
}

/** Settings dialog opened. source=trigger (button/shortcut) */
export function trackSettingsOpen(trigger: string): void {
  sampleRUM?.('signup', { source: trigger });
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
