import { isUserFixableError } from '../core/error-families.js';
import {
  errorDetailsToRawString,
  formatErrorDetails,
  unwrapStructuredErrorMessage,
} from '../core/error-text.js';
import { setAgentErrorTelemetrySink } from '../core/telemetry-hook.js';
import { type ScoopLifecycleEvent, setScoopTelemetrySink } from '../scoops/scoop-telemetry-hook.js';
import { setShellTelemetrySink } from '../shell/telemetry-hook.js';

type SampleRUM = (checkpoint: string, data?: { source?: string; target?: string }) => void;

type RumWorkerGlobals = {
  RUM_GENERATION?: string;
};

let sampleRUM: SampleRUM | null = null;
let initialized = false;

declare global {
  interface Window {
    SAMPLE_PAGEVIEWS_AT_RATE?: string;
    RUM_BASE?: string;
    RUM_GENERATION?: string;
  }
}

function isWorkerLikeRealm(): boolean {
  return (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof (document as Document | undefined)?.documentElement === 'undefined' ||
    typeof (localStorage as Storage | undefined)?.getItem !== 'function'
  );
}

function getModeLabel(
  isExtensionRealm: boolean
): 'cli' | 'extension' | 'electron' | 'standalone-worker' {
  if (isWorkerLikeRealm()) return 'standalone-worker';
  if (isExtensionRealm) return 'extension';
  if (typeof document !== 'undefined' && document.documentElement?.dataset?.electronOverlay)
    return 'electron';
  return 'cli';
}

export async function initTelemetry(opts: { isExtensionRealm?: boolean } = {}): Promise<void> {
  if (initialized) return;
  if (
    typeof localStorage !== 'undefined' &&
    typeof localStorage?.getItem === 'function' &&
    localStorage.getItem('telemetry-disabled') === 'true'
  )
    return;

  setShellTelemetrySink(trackShellCommand);

  setScoopTelemetrySink(trackScoopLifecycle);

  setAgentErrorTelemetrySink(trackError);

  try {
    const mode = getModeLabel(opts.isExtensionRealm ?? false);

    if (mode !== 'standalone-worker' && typeof window !== 'undefined') {
      window.RUM_GENERATION = `slicc-${mode}`;
    } else {
      (globalThis as RumWorkerGlobals).RUM_GENERATION = `slicc-${mode}`;
    }

    if (mode === 'standalone-worker') {
      const mod = await import('./rum-worker.js');
      sampleRUM = mod.default as SampleRUM;
      bindRuntimeErrorListeners(self);
    } else if (mode === 'extension') {
      const mod = await import('./rum.js');
      sampleRUM = mod.default as SampleRUM;

      if (typeof window !== 'undefined') {
        bindRuntimeErrorListeners(window);
      }
    } else {
      if (typeof window !== 'undefined') {
        window.SAMPLE_PAGEVIEWS_AT_RATE = 'high';
      }

      wrapSendBeaconForViteFilter();
      interceptHelixPojoErrors();
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
  } catch {}
}

export function trackChatSend(scoopName: string, model: string): void {
  sampleRUM?.('formsubmit', { source: scoopName, target: model });
}

export function trackShellCommand(commandName: string): void {
  sampleRUM?.('fill', { source: commandName });
}

export function trackSprinkleView(sprinkleName: string): void {
  sampleRUM?.('viewblock', { source: sprinkleName });
}

export function trackImageView(context: string): void {
  sampleRUM?.('viewmedia', { source: context });
}

export function trackError(errorType: string, details?: unknown): void {
  const target = sanitizeErrorTarget(details);
  if (target === null) return;
  sampleRUM?.('error', { source: errorType, target });
}

export function trackLickBackpressure(scoopName: string, waitingMs: number): void {
  sampleRUM?.('lick-backpressure', { source: scoopName, target: String(waitingMs) });
}

export function trackSettingsOpen(trigger: string): void {
  sampleRUM?.('signup', { source: trigger });
}

export function trackScoopLifecycle(
  event: ScoopLifecycleEvent,
  scoopName: string,
  details?: unknown
): void {
  if (event === 'error') {
    const target = sanitizeErrorTarget(details);
    if (target === null) return;
    sampleRUM?.('error', { source: `scoop:${scoopName}`, target });
    return;
  }
  const checkpoint = event === 'spawn' ? 'enter' : event === 'feed' ? 'convert' : 'leave';
  sampleRUM?.(checkpoint, { source: scoopName, target: `scoop-${event}` });
}

function isViteDevFrame(line: string): boolean {
  return (
    line.includes('@vite/client') ||
    line.includes('@vite/env') ||
    line.includes('[vite]') ||
    /https?:\/\/localhost:\d+\/@vite\//.test(line) ||
    /\/__vite_ping/.test(line)
  );
}

function sanitizeErrorTarget(details: unknown): string | null | undefined {
  const raw = errorDetailsToRawString(details);
  if (raw === undefined) return details === undefined || details === null ? undefined : null;

  if (isUserFixableError(raw)) return null;
  const formatted = formatErrorDetails(details) ?? unwrapStructuredErrorMessage(raw);
  if (isUserFixableError(formatted)) return null;
  return sanitizeError(formatted);
}

function bindRuntimeErrorListeners(target: {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
}): void {
  target.addEventListener('error', (e) => {
    const evt = e as ErrorEvent;
    trackError('js', evt.error ?? evt.message ?? '');
  });
  target.addEventListener('unhandledrejection', (e) => {
    trackError('js', (e as PromiseRejectionEvent).reason);
  });
}

function isNonErrorObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !(value instanceof Error);
}

function interceptHelixPojoErrors(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener(
    'error',
    (e) => {
      const err = (e as ErrorEvent).error;
      if (!isNonErrorObject(err)) return;
      trackError('js', err);
      e.stopImmediatePropagation();
    },
    true
  );
  window.addEventListener(
    'unhandledrejection',
    (e) => {
      const reason = (e as PromiseRejectionEvent).reason;
      if (!isNonErrorObject(reason)) return;
      trackError('js', reason);
      e.stopImmediatePropagation();
    },
    true
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

const SENDBEACON_WRAPPED = Symbol.for('slicc.telemetry.sendBeacon.wrapped');

type ParsedBeacon = { checkpoint?: string; source?: unknown; target?: unknown };

type FieldOutcome =
  | { kind: 'absent' }
  | { kind: 'kept'; value: string; mutated: boolean }
  | { kind: 'noise' };

function sanitizeBeaconField(raw: unknown): FieldOutcome {
  const asString =
    typeof raw === 'string' ? raw : (formatErrorDetails(raw) ?? errorDetailsToRawString(raw));
  if (typeof asString !== 'string') return { kind: 'absent' };
  const unwrapped = unwrapStructuredErrorMessage(asString);

  if (unwrapped === '[object Object]') return { kind: 'noise' };
  const sanitized = sanitizeError(unwrapped);
  if (sanitized === null) return { kind: 'noise' };
  return { kind: 'kept', value: sanitized, mutated: sanitized !== raw };
}

function sanitizeErrorBeaconBody(parsed: ParsedBeacon): true | string | null {
  const sourceOutcome = sanitizeBeaconField(parsed.source);
  const targetOutcome = sanitizeBeaconField(parsed.target);

  const sourceVotesDrop = sourceOutcome.kind !== 'kept';
  const targetVotesDrop = targetOutcome.kind !== 'kept';
  const eitherPresent = sourceOutcome.kind !== 'absent' || targetOutcome.kind !== 'absent';
  if (eitherPresent && sourceVotesDrop && targetVotesDrop) return true;

  if (targetOutcome.kind === 'noise' && parsed.source === 'undefined error') return true;
  let mutated = false;
  if (sourceOutcome.kind === 'kept') {
    if (sourceOutcome.mutated) {
      parsed.source = sourceOutcome.value;
      mutated = true;
    }
  } else if (sourceOutcome.kind === 'noise') {
    parsed.source = '';
    mutated = true;
  }
  if (targetOutcome.kind === 'kept') {
    if (targetOutcome.mutated) {
      parsed.target = targetOutcome.value;
      mutated = true;
    }
  } else if (targetOutcome.kind === 'noise') {
    parsed.target = '';
    mutated = true;
  }
  return mutated ? JSON.stringify(parsed) : null;
}

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
      if (text && text.length > 0 && text.charCodeAt(0) === 123) {
        const parsed = JSON.parse(text) as ParsedBeacon;
        if (parsed?.checkpoint === 'error') {
          const outcome = sanitizeErrorBeaconBody(parsed);
          if (outcome === true) return true;
          if (outcome !== null) return original(url, outcome);
        }
      }
    } catch {}
    return original(url, data);
  }) as typeof navigator.sendBeacon & { [SENDBEACON_WRAPPED]?: boolean };
  wrapped[SENDBEACON_WRAPPED] = true;
  navigator.sendBeacon = wrapped;
}

export function isTelemetryEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem('telemetry-disabled') !== 'true';
}

export function setTelemetryEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (enabled) {
    localStorage.removeItem('telemetry-disabled');
  } else {
    localStorage.setItem('telemetry-disabled', 'true');
  }
}
