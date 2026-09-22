// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  RESTORING_SESSION_NOTICE_TEXT,
  syncRestoringSessionNotice,
  threadColumnIsEmpty,
} from '../../../src/ui/wc/restoring-session-notice.js';

function thread(): HTMLElement {
  const el = document.createElement('slicc-chat-thread');
  const inner = document.createElement('div');
  inner.className = 'slicc-thread__inner';
  el.append(inner);
  return el;
}

describe('restoring session notice', () => {
  it('fills an empty thread and leaves a transcript that is already there', () => {
    const empty = thread();
    expect(threadColumnIsEmpty(empty)).toBe(true);
    syncRestoringSessionNotice(empty, true);
    expect(empty.querySelector('.slicc-restoring-session')?.textContent).toBe(
      RESTORING_SESSION_NOTICE_TEXT
    );
    expect(threadColumnIsEmpty(empty)).toBe(true);

    const filled = thread();
    const row = document.createElement('slicc-user-message');
    filled.querySelector('.slicc-thread__inner')?.append(row);
    expect(threadColumnIsEmpty(filled)).toBe(false);
    // The shell only asks for the notice when the column is still empty,
    // so a transcript that arrived first is left alone.
    syncRestoringSessionNotice(filled, threadColumnIsEmpty(filled));
    expect(filled.querySelector('.slicc-restoring-session')).toBeNull();
  });

  it('removes the notice once restoring is over', () => {
    const el = thread();
    syncRestoringSessionNotice(el, true);
    syncRestoringSessionNotice(el, false);
    expect(el.querySelector('.slicc-restoring-session')).toBeNull();
    expect(threadColumnIsEmpty(el)).toBe(true);
  });
});
