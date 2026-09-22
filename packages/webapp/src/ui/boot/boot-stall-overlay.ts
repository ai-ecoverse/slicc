const OVERLAY_ID = 'slicc-boot-stall-overlay';
const STAGE_ID = 'slicc-boot-stage';

const STATUS_STYLE =
  'position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:2147483000;' +
  'display:flex;gap:0.75rem;align-items:center;padding:0.75rem 1rem;border-radius:8px;' +
  'font-family:system-ui;font-size:0.875rem;max-width:min(90vw,34rem);' +
  'background:var(--s2-background-elevated, #1e1e1e);color:var(--s2-content, #eee);' +
  'border:1px solid var(--s2-content-tertiary, #717171);box-shadow:0 4px 16px rgba(0,0,0,0.4);';

export interface BootStallOverlayDeps {
  reload?: () => void;
}

export function showBootStage(doc: Document, stage: string): void {
  if (doc.getElementById(OVERLAY_ID)) return;
  const message = `Starting — ${stage}`;
  const existing = doc.getElementById(STAGE_ID);
  if (existing) {
    const p = existing.querySelector('p');
    if (p) p.textContent = message;
    return;
  }
  const box = doc.createElement('div');
  box.id = STAGE_ID;
  box.style.cssText = STATUS_STYLE;
  const p = doc.createElement('p');
  p.style.cssText = 'margin:0;';
  p.textContent = message;
  box.append(p);
  doc.body.appendChild(box);
}

export function removeBootStage(doc: Document): void {
  doc.getElementById(STAGE_ID)?.remove();
}

export function showBootStallOverlay(
  doc: Document,
  info: { elapsedMs: number; stage?: string },
  deps: BootStallOverlayDeps = {}
): void {
  removeBootStage(doc);
  const elapsedSec = Math.max(1, Math.round(info.elapsedMs / 1000));
  const stage = info.stage ? ` Last progress: ${info.stage}.` : '';
  const message =
    `Still starting — the kernel is taking longer than expected (${elapsedSec}s).${stage} ` +
    'Waiting is safe; your data is untouched.';

  const existing = doc.getElementById(OVERLAY_ID);
  if (existing) {
    const p = existing.querySelector('p');
    if (p) p.textContent = message;
    return;
  }

  const box = doc.createElement('div');
  box.id = OVERLAY_ID;
  box.style.cssText = STATUS_STYLE;

  const p = doc.createElement('p');
  p.style.cssText = 'margin:0;';
  p.textContent = message;

  const reloadBtn = doc.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = 'Reload';
  reloadBtn.style.cssText =
    'padding:0.35rem 0.75rem;cursor:pointer;border:1px solid var(--s2-content-tertiary, #717171);' +
    'background:transparent;color:inherit;border-radius:4px;flex-shrink:0;';
  const reload = deps.reload ?? ((): void => location.reload());
  reloadBtn.addEventListener('click', () => reload());

  box.append(p, reloadBtn);
  doc.body.appendChild(box);
}

export function removeBootStallOverlay(doc: Document): void {
  doc.getElementById(OVERLAY_ID)?.remove();
}
