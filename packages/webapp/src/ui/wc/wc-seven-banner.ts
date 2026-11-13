/**
 * The SLICC 7 banner: "SLICC 7 is here. [Try the upgrade] [Export your profile] ×".
 *
 * Sits between the nav and the shell in the app column, so it takes real
 * layout space instead of covering the nav. "Try the upgrade" opens seven at
 * www.sliccy.ai/7/. On www itself, where seven runs on the same origin and
 * moves the profile in place (slicc#4051, ai-ecoverse/slicc-bios#648), it
 * opens in this tab; anywhere else (localhost, a custom origin) it opens in a
 * new tab, and "Export your profile" (the Export for SLICC 7 dialog) is how
 * that profile gets there. Shown while the `seven-banner` flag is on (on by
 * default; gated by the caller in `wc-live.ts`). Dismissing it is remembered
 * per origin; the Settings entry stays.
 */

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';

export const SEVEN_BANNER_ID = 'slicc-seven-banner';
/** Seven's BIOS on www, which runs the in-place upgrade. */
export const SEVEN_UPGRADE_URL = `${SLICC_HOSTED_ORIGIN}/7/`;
/**
 * Per-origin dismissal. A new key for the "Try the upgrade" banner, so a
 * dismissal of the earlier "SLICC 7 is at seven.sliccy.ai" banner does not
 * hide it.
 */
export const SEVEN_BANNER_DISMISSED_KEY = 'slicc-seven-upgrade-banner-dismissed';

const STYLE_ID = 'slicc-seven-banner-style';
const CSS = `
.wcsev{display:flex;align-items:center;gap:10px;margin:6px 12px 0;padding:7px 8px 7px 14px;border-radius:10px;
  font:500 12.5px/1.4 var(--ui);color:var(--ink);
  background:color-mix(in srgb,var(--ctx) 12%,var(--canvas));
  border:1px solid color-mix(in srgb,var(--ctx) 35%,var(--line));flex:0 0 auto;}
.wcsev__text{flex:1;min-width:0;}
.wcsev__export{font:600 12px var(--ui);color:var(--canvas);background:var(--ink);border:1px solid var(--ink);
  border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap;}
.wcsev__export:hover{background:color-mix(in srgb,var(--ink) 85%,var(--canvas));}
.wcsev__export--secondary{color:var(--ink);background:transparent;border-color:color-mix(in srgb,var(--ink) 30%,var(--line));}
.wcsev__export--secondary:hover{background:var(--ghost);}
a.wcsev__upgrade{color:var(--canvas);text-decoration:none;font-weight:600;}
.wcsev__close{font:500 16px/1 var(--ui);color:var(--txt-2);background:transparent;border:0;border-radius:6px;
  width:26px;height:26px;cursor:pointer;flex:0 0 auto;}
.wcsev__close:hover{background:var(--ghost);color:var(--ink);}
@media (max-width:560px){.wcsev{margin:6px 8px 0;font-size:12px;flex-wrap:wrap;row-gap:6px;}
  .wcsev__text{flex-basis:100%;}.wcsev__export{padding:4px 8px;}.wcsev__close{margin-left:auto;}}
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

/** True on www, where seven shares the origin and the upgrade moves this profile in place. */
export function upgradesInPlace(origin: string): boolean {
  return origin === SLICC_HOSTED_ORIGIN;
}

export interface SevenBannerOptions {
  /** Opens the Export for SLICC 7 dialog. */
  onExport(): void;
  /** This page's origin; decides whether "Try the upgrade" opens in this tab. */
  origin: string;
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
  text.textContent = 'SLICC 7 is here.';

  const upgrade = doc.createElement('a');
  upgrade.className = 'wcsev__export wcsev__upgrade';
  upgrade.href = SEVEN_UPGRADE_URL;
  upgrade.textContent = 'Try the upgrade';
  if (!upgradesInPlace(opts.origin)) {
    upgrade.target = '_blank';
    upgrade.rel = 'noopener';
  }

  const exportBtn = doc.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'wcsev__export wcsev__export--secondary';
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

  banner.append(text, upgrade, exportBtn, close);
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
