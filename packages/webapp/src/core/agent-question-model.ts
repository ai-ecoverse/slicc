import type {
  PredictedQuestion,
  QuestionWorkerIn,
  QuestionWorkerOut,
} from './agent-question-worker.js';

/** Model-backed question detection. The worker and weights load only on the first finished message. */
export interface AgentQuestionParser {
  parse(text: string): Promise<PredictedQuestion[]>;
}

let parser: AgentQuestionParser | undefined;

export function loadAgentQuestionParser(): AgentQuestionParser {
  if (parser) return parser;
  const worker = new Worker(new URL('./agent-question-worker.ts', import.meta.url), {
    type: 'module',
  });
  const pending = new Map<
    number,
    { resolve: (questions: PredictedQuestion[]) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  worker.addEventListener('message', (event: MessageEvent<QuestionWorkerOut>) => {
    const result = event.data;
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    if ('error' in result) request.reject(new Error(result.error));
    else request.resolve(result.questions);
  });
  worker.addEventListener('error', (event) => {
    for (const request of pending.values()) request.reject(new Error(event.message));
    pending.clear();
    parser = undefined;
    worker.terminate();
  });
  parser = {
    parse(text) {
      const id = ++nextId;
      const baseUrl = new URL(
        __GPU_ASK_ASSET_BASE__,
        new URL(import.meta.env.BASE_URL, location.origin)
      ).href;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, text, baseUrl } satisfies QuestionWorkerIn);
      });
    },
  };
  return parser;
}
