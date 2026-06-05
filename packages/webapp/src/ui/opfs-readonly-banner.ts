/**
 * Non-blocking read-only banner shown when this tab lost the
 * cross-tab OPFS leader election. The banner is purely informational
 * — it does NOT capture pointer events outside its own bounds. A
 * small × dismisses it for this tab.
 *
 * Inline styles so the banner renders correctly in test harnesses,
 * popouts, and any context where the app stylesheet hasn't loaded.
 */

export interface OpfsReadOnlyBannerOptions {
  /** Document to attach the banner to. Defaults to `document`. */
  doc?: Document;
  /** Optional leader tab id to include in the message. */
  leaderTabId?: string;
}

export interface OpfsReadOnlyBannerHandle {
  /** The banner element. */
  element: HTMLElement;
  /** Remove the banner. Idempotent. */
  dismiss: () => void;
}

const BANNER_ID = 'slicc-opfs-readonly-banner';

/**
 * Mount a non-blocking read-only banner. Returns a handle with the
 * element and a `dismiss()` to remove it. Calling again while a
 * banner is already mounted returns the existing handle (idempotent).
 */
export function showOpfsReadOnlyBanner(
  options: OpfsReadOnlyBannerOptions = {}
): OpfsReadOnlyBannerHandle {
  const doc = options.doc ?? document;
  const existing = doc.getElementById(BANNER_ID);
  if (existing instanceof HTMLElement) {
    return {
      element: existing,
      dismiss: () => existing.remove(),
    };
  }

  const banner = doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  // `pointer-events: none` on the wrapper so the banner stays
  // non-blocking; the inner pill re-enables pointer events so the
  // dismiss button stays clickable. Layout via cssText, pointer-events
  // set individually so test environments that don't fully parse a
  // multi-property cssText still see the non-blocking contract.
  banner.style.cssText =
    'position: fixed; top: 0; left: 0; right: 0; z-index: 99998;' +
    ' display: flex; justify-content: center; padding: 6px 0;';
  banner.style.pointerEvents = 'none';

  const pill = doc.createElement('div');
  pill.style.cssText =
    'display: inline-flex; align-items: center; gap: 8px;' +
    ' max-width: 640px; padding: 6px 12px; background: rgba(40, 40, 40, 0.92);' +
    ' color: #fff; font-size: 12px; line-height: 1.4; border-radius: 999px;' +
    ' box-shadow: 0 2px 8px rgba(0,0,0,0.25);';
  pill.style.pointerEvents = 'auto';

  const text = doc.createElement('span');
  text.textContent =
    'Read-only: another SLICC tab is the writer for this workspace. ' +
    'Close that tab to take over.';

  const dismissBtn = doc.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.setAttribute('aria-label', 'Dismiss read-only notice');
  dismissBtn.textContent = '×';
  dismissBtn.style.cssText =
    'border: 0; background: transparent; color: #fff; font-size: 16px;' +
    ' line-height: 1; cursor: pointer; padding: 0 2px;';
  dismissBtn.addEventListener('click', () => banner.remove());

  pill.appendChild(text);
  pill.appendChild(dismissBtn);
  banner.appendChild(pill);
  doc.body.appendChild(banner);

  return {
    element: banner,
    dismiss: () => banner.remove(),
  };
}
