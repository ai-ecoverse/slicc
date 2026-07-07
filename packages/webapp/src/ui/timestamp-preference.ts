const STORAGE_KEY = 'slicc_show_timestamps';
const CSS_CLASS = 'slicc-show-timestamps';
const STYLE_ID = 'slicc-timestamp-visibility';

let initialized = false;

function ensureTimestampStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    'slicc-user-message::part(timestamp),',
    'slicc-agent-message .msg-ts {',
    '  display: none;',
    '}',
    `.${CSS_CLASS} slicc-user-message::part(timestamp),`,
    `.${CSS_CLASS} slicc-agent-message .msg-ts {`,
    '  display: block;',
    '}',
  ].join('\n');
  doc.head.appendChild(style);
}

export function getShowTimestamps(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return true;
  return stored === 'true';
}

export function setShowTimestamps(show: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(show));
  applyTimestampVisibility();
}

export function applyTimestampVisibility(): void {
  ensureTimestampStyle(document);
  document.documentElement.classList.toggle(CSS_CLASS, getShowTimestamps());
  initialized = true;
}

export function initTimestampPreference(): void {
  if (initialized) return;
  applyTimestampVisibility();
}

export function formatMessageTimestamp(timestamp: number): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
