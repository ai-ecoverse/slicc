/**
 * The SLICC 7 banner: "SLICC 7 is at seven.sliccy.ai. Export your profile."
 *
 * Sits between the nav and the shell in the app column, so it takes real
 * layout space instead of covering the nav. "Export your profile" opens the
 * Export for SLICC 7 dialog. Dismissing it is remembered per origin; the
 * Settings entry stays.
 */

export const SEVEN_BANNER_ID = 'slicc-seven-banner';
export const SEVEN_BANNER_DISMISSED_KEY = 'slicc-seven-banner-dismissed';

const STYLE_ID = 'slicc-seven-banner-style';
const CSS = `
.wcsev{display:flex;align-items:center;gap:10px;margin:6px 12px 0;padding:7px 8px 7px 14px;border-radius:10px;
  font:500 12.5px/1.4 var(--ui);color:var(--ink);
  background:color-mix(in srgb,var(--ctx) 12%,var(--canvas));
  border:1px solid color-mix(in srgb,var(--ctx) 35%,var(--line));flex:0 0 auto;}
.wcsev__text{flex:1;min-width:0;}
.wcsev a{color:var(--ink);font-weight:600;text-decoration:underline;text-underline-offset:2px;}
.wcsev__export{font:600 12px var(--ui);color:var(--canvas);background:var(--ink);border:1px solid var(--ink);
  border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap;}
.wcsev__export:hover{background:color-mix(in srgb,var(--ink) 85%,var(--canvas));}
.wcsev__close{font:500 16px/1 var(--ui);color:var(--txt-2);background:transparent;border:0;border-radius:6px;
  width:26px;height:26px;cursor:pointer;flex:0 0 auto;}
.wcsev__close:hover{background:var(--ghost);color:var(--ink);}
@media (max-width:560px){.wcsev{margin:6px 8px 0;font-size:12px;}.wcsev__export{padding:4px 8px;}}
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function isDismissed(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(SEVEN_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export interface SevenBannerOptions {
  /** Opens the Export for SLICC 7 dialog. */
  onExport(): void;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * Mount the banner into `host` before `before` (or at the end). Idempotent;
 * returns the banner, or null when it is already shown or was dismissed.
 */
export function mountSevenBanner(
  doc: Document,
  host: HTMLElement,
  before: Element | null,
  opts: SevenBannerOptions
): HTMLElement | null {
  const storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
  if (doc.getElementById(SEVEN_BANNER_ID) || isDismissed(storage)) return null;
  ensureStyle(doc);
  const banner = doc.createElement('div');
  banner.id = SEVEN_BANNER_ID;
  banner.className = 'wcsev';
  banner.setAttribute('role', 'status');

  const text = doc.createElement('span');
  text.className = 'wcsev__text';
  const link = doc.createElement('a');
  link.href = 'https://seven.sliccy.ai';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'seven.sliccy.ai';
  text.append('SLICC 7 is at ', link, '.');

  const exportBtn = doc.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'wcsev__export';
  exportBtn.textContent = 'Export your profile';
  exportBtn.addEventListener('click', () => opts.onExport());

  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'wcsev__close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => {
    try {
      storage?.setItem(SEVEN_BANNER_DISMISSED_KEY, '1');
    } catch {
      // A storage failure only means the banner comes back next boot.
    }
    banner.remove();
  });

  banner.append(text, exportBtn, close);
  host.insertBefore(banner, before && before.parentNode === host ? before : null);
  return banner;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
