// @vitest-environment jsdom

/**
 * Non-blocking read-only banner shown to followers when this tab
 * lost the cross-tab OPFS leader election.
 *
 * Pins:
 *  - Mounts a single banner with `role=status` so screen readers
 *    announce it without trapping focus.
 *  - Banner wrapper is non-blocking (`pointer-events: none`); the
 *    inner pill re-enables pointer events so the × stays clickable.
 *  - Idempotent: calling `show` twice returns the same element.
 *  - `dismiss()` removes the banner from the DOM.
 *  - The dismiss button removes the banner on click.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { showOpfsReadOnlyBanner } from '../../src/ui/opfs-readonly-banner.js';

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(clearBody);
afterEach(clearBody);

describe('showOpfsReadOnlyBanner', () => {
  it('mounts a single banner with role=status into the document', () => {
    const handle = showOpfsReadOnlyBanner({ doc: document });
    expect(handle.element.isConnected).toBe(true);
    expect(handle.element.getAttribute('role')).toBe('status');
    expect(handle.element.getAttribute('aria-live')).toBe('polite');
    expect(handle.element.id).toBe('slicc-opfs-readonly-banner');
    expect(handle.element.textContent ?? '').toContain('Read-only');
  });

  it('is non-blocking at the wrapper but interactive at the pill', () => {
    const handle = showOpfsReadOnlyBanner({ doc: document });
    // The wrapper must not capture pointer events outside the pill.
    expect(handle.element.style.pointerEvents).toBe('none');
    const pill = handle.element.firstElementChild as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.style.pointerEvents).toBe('auto');
  });

  it('is idempotent: a second call returns the existing banner', () => {
    const first = showOpfsReadOnlyBanner({ doc: document });
    const second = showOpfsReadOnlyBanner({ doc: document });
    expect(second.element).toBe(first.element);
    // Only one banner element is mounted.
    expect(document.querySelectorAll('#slicc-opfs-readonly-banner').length).toBe(1);
  });

  it('dismiss() removes the banner from the DOM', () => {
    const handle = showOpfsReadOnlyBanner({ doc: document });
    handle.dismiss();
    expect(handle.element.isConnected).toBe(false);
    expect(document.querySelectorAll('#slicc-opfs-readonly-banner').length).toBe(0);
  });

  it('the dismiss button removes the banner on click', () => {
    const handle = showOpfsReadOnlyBanner({ doc: document });
    const button = handle.element.querySelector('button');
    expect(button).not.toBeNull();
    (button as HTMLButtonElement).click();
    expect(handle.element.isConnected).toBe(false);
  });
});
