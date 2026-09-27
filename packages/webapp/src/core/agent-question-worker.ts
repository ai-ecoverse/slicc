import { type AskModel, loadAsk, parse } from '@ai-ecoverse/gpu-ask.js';
import * as ort from 'onnxruntime-web/wasm';

export interface PredictedQuestion {
  prompt: string;
  kind: string;
  options: string[];
  default: number | null;
  multiSelect: boolean;
  span: [number, number];
}

export type QuestionWorkerIn = { id: number; text: string; baseUrl: string };
export type QuestionWorkerOut =
  | { id: number; questions: PredictedQuestion[] }
  | { id: number; error: string };

let model: Promise<AskModel> | undefined;
let queue = Promise.resolve();

async function predict({ id, text, baseUrl }: QuestionWorkerIn): Promise<void> {
  try {
    ort.env.wasm.wasmPaths = {
      wasm: `${baseUrl}runtime/inference.wasm`,
      mjs: `${baseUrl}runtime/inference.mjs`,
    };
    ort.env.wasm.numThreads = 1;
    model ??= loadAsk(`${baseUrl}v13/`, { ort: ort as never }).catch((error: unknown) => {
      model = undefined;
      throw error;
    });
    const { questions, text: normalized } = await parse(await model, text);
    if (normalized !== text) throw new Error('Model normalization changed question offsets');
    self.postMessage({ id, questions } satisfies QuestionWorkerOut);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies QuestionWorkerOut);
  }
}

self.addEventListener('message', (event: MessageEvent<QuestionWorkerIn>) => {
  queue = queue.then(() => predict(event.data));
});
