/** Limits apply before buffering, including chunked requests without Content-Length. */
export const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;
export const WEBHOOK_IO_TIMEOUT_MS = 5_000;

export class WebhookBodyError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Bound the whole operation, not merely receipt of response headers. */
export async function withWebhookTimeout<T>(
  operation: Promise<T>,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new WebhookBodyError('Webhook operation timed out', 408));
        }, WEBHOOK_IO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own a bounded copy before crossing a DO request-context boundary. */
export async function readBoundedWebhookBody(request: Request | Response): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    await withWebhookTimeout(
      (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          length += chunk.value.byteLength;
          if (length > WEBHOOK_BODY_MAX_BYTES) {
            throw new WebhookBodyError('Webhook body exceeds 64 KiB', 413);
          }
          chunks.push(chunk.value);
        }
      })()
    );
  } catch (error) {
    // A hostile source need not resolve cancel(); do not extend the deadline.
    void reader.cancel().catch(() => {});
    throw error;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
