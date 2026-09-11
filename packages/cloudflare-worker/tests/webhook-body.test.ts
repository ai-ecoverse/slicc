import { describe, expect, it, vi } from 'vitest';
import { readBoundedWebhookBody, WEBHOOK_BODY_MAX_BYTES } from '../src/webhook-body.js';

describe('bounded webhook request body', () => {
  it('round trips arbitrary bytes without a content-length declaration', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 239, 187, 191]);
    expect(await readBoundedWebhookBody(new Response(bytes))).toEqual(bytes);
  });

  it('rejects a chunked body at the accumulated byte limit and cancels its source', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(WEBHOOK_BODY_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      })
    );
    await expect(readBoundedWebhookBody(response)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalled();
  });

  it('bounds a stalled stream even when cancellation never settles', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const pending = readBoundedWebhookBody(new Response(new ReadableStream({ cancel })));
      const rejected = expect(pending).rejects.toMatchObject({ status: 408 });
      await vi.advanceTimersByTimeAsync(5_001);
      await rejected;
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
