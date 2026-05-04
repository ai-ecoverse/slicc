/**
 * Tiny clipboard helpers shared by UI components.
 *
 * The async Clipboard API is the happy path, but extension popups,
 * cross-origin iframes, and older runtimes can deny access. The
 * helpers below fall back to a hidden textarea so the user still
 * gets working copy/paste.
 */

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to textarea fallback */
    }
  }

  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed; opacity:0; pointer-events:none; left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export async function readTextFromClipboard(): Promise<string | null> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
  return null;
}
