import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionWorkerIn, QuestionWorkerOut } from '../../src/core/agent-question-worker.js';

const mocks = vi.hoisted(() => ({ loadAsk: vi.fn(), parse: vi.fn() }));

vi.mock('@ai-ecoverse/gpu-ask.js', () => mocks);
vi.mock('onnxruntime-web/wasm', () => ({ env: { wasm: {} } }));

describe('agent question worker', () => {
  let onMessage: (event: MessageEvent<QuestionWorkerIn>) => void;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mocks.loadAsk.mockReset();
    mocks.parse.mockReset();
    postMessage = vi.fn();
    vi.stubGlobal('self', {
      addEventListener: (_type: string, handler: typeof onMessage) => {
        onMessage = handler;
      },
      postMessage,
    });
    await import('../../src/core/agent-question-worker.js');
  });

  afterEach(() => vi.unstubAllGlobals());

  async function send(id: number, text: string): Promise<QuestionWorkerOut> {
    onMessage({
      data: { id, text, baseUrl: '/assets/gpu-ask-test/' },
    } as MessageEvent<QuestionWorkerIn>);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(id));
    return postMessage.mock.calls[id - 1]?.[0] as QuestionWorkerOut;
  }

  it('keeps loaded weights after a per-message offset error', async () => {
    const model = { sessions: [] };
    mocks.loadAsk.mockResolvedValue(model);
    mocks.parse
      .mockResolvedValueOnce({ text: 'normalized', questions: [] })
      .mockResolvedValueOnce({ text: 'Second question?', questions: [] });

    expect(await send(1, 'First question?')).toEqual({
      id: 1,
      error: 'Model normalization changed question offsets',
    });
    expect(await send(2, 'Second question?')).toEqual({ id: 2, questions: [] });
    expect(mocks.loadAsk).toHaveBeenCalledTimes(1);
    expect(mocks.parse).toHaveBeenCalledTimes(2);
  });

  it('retries loading after a model-load failure', async () => {
    mocks.loadAsk
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce({ sessions: [] });
    mocks.parse.mockResolvedValue({ text: 'Second question?', questions: [] });

    expect(await send(1, 'First question?')).toEqual({ id: 1, error: 'load failed' });
    expect(await send(2, 'Second question?')).toEqual({ id: 2, questions: [] });
    expect(mocks.loadAsk).toHaveBeenCalledTimes(2);
  });
});
