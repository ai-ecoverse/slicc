/**
 * The line an empty thread shows while boot has not yet delivered that
 * scoop's saved history. A blank thread reads as "the conversation is gone";
 * this says the reload is still putting it back.
 */
export const RESTORING_SESSION_NOTICE_TEXT = 'Restoring session…';

const NOTICE_CLASS = 'slicc-restoring-session';

/** True when the reading column has nothing but the restoring notice. */
export function threadColumnIsEmpty(thread: HTMLElement): boolean {
  const inner = thread.querySelector(':scope > .slicc-thread__inner') ?? thread;
  for (const child of inner.children) {
    if (!child.classList.contains(NOTICE_CLASS)) return false;
  }
  return true;
}

/** Show or remove the notice inside the thread's reading column. */
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
