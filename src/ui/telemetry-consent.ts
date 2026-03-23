/**
 * Telemetry consent banner for Chrome Web Store compliance.
 * Extension mode requires explicit opt-in before sending any RUM data.
 */

const CONSENT_KEY = 'telemetry-consent';

export type ConsentState = 'granted' | 'denied' | null;

/** Read the stored consent decision, or null if none has been made. */
export function getTelemetryConsent(): ConsentState {
  const value = localStorage.getItem(CONSENT_KEY);
  if (value === 'granted' || value === 'denied') return value;
  return null;
}

/** Persist a consent decision. */
export function setTelemetryConsent(state: 'granted' | 'denied'): void {
  localStorage.setItem(CONSENT_KEY, state);
}

interface ConsentResult {
  /** The banner element, or null if consent was already decided. */
  banner: HTMLElement | null;
  /** Resolves with the consent state once the user acts (or immediately if already decided). */
  promise: Promise<ConsentState>;
}

/**
 * Show a non-blocking consent banner at the top of the given container.
 * Returns immediately if the user has already made a decision.
 */
export function showTelemetryConsent(container: HTMLElement): ConsentResult {
  const existing = getTelemetryConsent();
  if (existing) {
    return { banner: null, promise: Promise.resolve(existing) };
  }

  const banner = document.createElement('div');
  banner.className = 'telemetry-consent';
  banner.innerHTML = [
    '<div class="telemetry-consent__text">',
    '<strong>Help improve slicc?</strong> ',
    'We collect anonymous usage stats (features used, errors). No personal data or conversations. ',
    'You can change this anytime in settings.',
    '</div>',
    '<div class="telemetry-consent__actions">',
    '<button class="dialog__btn--secondary" data-action="decline">No thanks</button>',
    '<button class="dialog__btn" data-action="allow">Allow</button>',
    '</div>',
  ].join('');

  container.prepend(banner);

  const promise = new Promise<ConsentState>((resolve) => {
    banner.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.dataset?.action;
      if (action === 'allow') {
        setTelemetryConsent('granted');
        banner.remove();
        resolve('granted');
      } else if (action === 'decline') {
        setTelemetryConsent('denied');
        banner.remove();
        resolve('denied');
      }
    });
  });

  return { banner, promise };
}
