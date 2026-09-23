/**
 * Turning an answer given on a question's hover card into a lick for the cone.
 *
 * The card (`wire-mention-previews.ts`) only reports the answer on the thread;
 * this is where it becomes a `question` sprinkle lick, addressed like an
 * inline dip's lick — to the unit whose transcript asked, captured at answer
 * time, never to whichever cone happens to be oldest.
 */

import {
  AGENT_QUESTION_ANSWER_EVENT,
  type AgentQuestionAnswerDetail,
} from '../mention-previews.js';

/** Wire name of the lick an answered agent question sends. */
export const QUESTION_LICK_NAME = 'question';

/** The body of a `question` lick, as the cone receives it. */
export interface QuestionLickBody {
  action: 'answer';
  data: Pick<AgentQuestionAnswerDetail, 'question' | 'kind' | 'answer'>;
}

type SendLick = (
  name: string,
  body: QuestionLickBody,
  targetScoop?: string,
  originUnitId?: string
) => void;

/**
 * Forward every answer dispatched on `thread` to `send`. Returns a teardown.
 */
export function wireQuestionAnswerLicks(
  thread: EventTarget,
  send: SendLick,
  originUnitId: () => string | null | undefined
): () => void {
  const onAnswer = (event: Event): void => {
    const detail = (event as CustomEvent<AgentQuestionAnswerDetail>).detail;
    if (!detail || typeof detail.answer !== 'string') return;
    const { question, kind, answer } = detail;
    send(
      QUESTION_LICK_NAME,
      { action: 'answer', data: { question, kind, answer } },
      undefined,
      originUnitId() ?? undefined
    );
  };
  thread.addEventListener(AGENT_QUESTION_ANSWER_EVENT, onAnswer);
  return () => thread.removeEventListener(AGENT_QUESTION_ANSWER_EVENT, onAnswer);
}
