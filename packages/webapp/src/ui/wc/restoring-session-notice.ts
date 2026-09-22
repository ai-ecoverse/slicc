export const RESTORING_SESSION_NOTICE_TEXT = 'Restoring session…';

const NOTICE_CLASS = 'slicc-restoring-session';

export function threadColumnIsEmpty(thread: HTMLElement): boolean {
  const inner = thread.querySelector(':scope > .slicc-thread__inner') ?? thread;
  for (const child of inner.children) {
    if (!child.classList.contains(NOTICE_CLASS)) return false;
  }
  return true;
}

export function syncRestoringSessionNotice(thread: HTMLElement, show: boolean): void {
  const inner = thread.querySelector(':scope > .slicc-thread__inner') ?? thread;
  const existing = inner.querySelector(`:scope > .${NOTICE_CLASS}`);
  if (!show) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const notice = thread.ownerDocument.createElement('p');
  notice.className = NOTICE_CLASS;
  notice.textContent = RESTORING_SESSION_NOTICE_TEXT;
  inner.append(notice);
}
