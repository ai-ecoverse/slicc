import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../../src/cdp/index.js';
import { evalHandler } from '../../../../../src/shell/supplemental-commands/playwright/handlers/eval.js';
import { createHandlerCtx } from '../../../helpers/playwright-harness.js';

describe('evalHandler frame targeting', () => {
  it('evaluates user expressions in the validated frame main world', async () => {
    const evaluate = vi.fn(async () => 'main-result');
    const evaluateInFrame = vi.fn(async () => 'frame-result');
    const browser = {
      withTab: async <T>(_targetId: string, fn: () => Promise<T>) => fn(),
      getFrameTree: vi.fn(async () => [
        { frameId: 'main', url: 'https://example.com', name: '' },
        {
          frameId: 'frame-1',
          parentFrameId: 'main',
          url: 'https://example.com/frame',
          name: '',
        },
      ]),
      evaluate,
      evaluateInFrame,
    } as unknown as BrowserAPI;

    const result = await evalHandler(
      createHandlerCtx({
        browser,
        positional: ['location.href'],
        flags: { tab: 'tab-1', frame: 'frame-1' },
      })
    );

    expect(result).toEqual({ stdout: 'frame-result\n', stderr: '', exitCode: 0 });
    expect(evaluateInFrame).toHaveBeenCalledWith('frame-1', 'location.href', { world: 'main' });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
