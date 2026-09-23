import {
  AGENT_QUESTION_ANSWER_EVENT,
  type AgentQuestionAnswerDetail,
} from '../mention-previews.js';

export const QUESTION_LICK_NAME = 'question';

export interface QuestionLickBody {
  action: 'answer';
  data: Pick<AgentQuestionAnswerDetail, 'question' | 'kind' | 'answer'> & {
    timeZone?: string;
  };
}

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

type SendLick = (
  name: string,
  body: QuestionLickBody,
  targetScoop?: string,
  originUnitId?: string
) => void;

export function wireQuestionAnswerLicks(
  thread: EventTarget,
  send: SendLick,
  originUnitId: () => string | null | undefined
): () => void {
  const onAnswer = (event: Event): void => {
    const detail = (event as CustomEvent<AgentQuestionAnswerDetail>).detail;
    if (!detail || typeof detail.answer !== 'string') return;
    const { question, kind, answer } = detail;

    const timeZone = kind === 'datetime' || kind === 'date' ? viewerTimeZone() : undefined;
    send(
      QUESTION_LICK_NAME,
      { action: 'answer', data: { question, kind, answer, ...(timeZone ? { timeZone } : {}) } },
      undefined,
      originUnitId() ?? undefined
    );
  };
  thread.addEventListener(AGENT_QUESTION_ANSWER_EVENT, onAnswer);
  return () => thread.removeEventListener(AGENT_QUESTION_ANSWER_EVENT, onAnswer);
}
