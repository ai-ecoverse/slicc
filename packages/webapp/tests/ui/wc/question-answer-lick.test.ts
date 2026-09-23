import { describe, expect, it, vi } from 'vitest';
import { AGENT_QUESTION_ANSWER_EVENT } from '../../../src/ui/mention-previews.js';
import {
  QUESTION_LICK_NAME,
  wireQuestionAnswerLicks,
} from '../../../src/ui/wc/question-answer-lick.js';

function answer(target: EventTarget, detail: unknown): void {
  target.dispatchEvent(new CustomEvent(AGENT_QUESTION_ANSWER_EVENT, { detail }));
}

describe('wireQuestionAnswerLicks', () => {
  it('sends an answer as a question lick addressed to the origin unit', () => {
    const thread = new EventTarget();
    const send = vi.fn();
    wireQuestionAnswerLicks(thread, send, () => 'cone-1');
    answer(thread, { question: 'Should I go?', kind: 'yes-no', answer: 'yes', messageId: 'm1' });
    expect(send).toHaveBeenCalledWith(
      QUESTION_LICK_NAME,
      { action: 'answer', data: { question: 'Should I go?', kind: 'yes-no', answer: 'yes' } },
      undefined,
      'cone-1'
    );
  });

  it('omits an unknown origin and ignores malformed events', () => {
    const thread = new EventTarget();
    const send = vi.fn();
    wireQuestionAnswerLicks(thread, send, () => null);
    answer(thread, null);
    answer(thread, { question: 'q' });
    expect(send).not.toHaveBeenCalled();
    answer(thread, { question: 'When?', kind: 'datetime', answer: '2026-09-24T10:00' });
    expect(send.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('stops forwarding after teardown', () => {
    const thread = new EventTarget();
    const send = vi.fn();
    const off = wireQuestionAnswerLicks(thread, send, () => 'c');
    off();
    answer(thread, { question: 'q?', kind: 'text', answer: 'a' });
    expect(send).not.toHaveBeenCalled();
  });
});
