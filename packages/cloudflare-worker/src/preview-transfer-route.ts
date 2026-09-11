import { extractBearer } from './preview-routes.js';
import { jsonResponse } from './shared.js';

const MAX_BODY_BYTES = 8 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 60_000;

interface TrayStub {
  fetch(request: Request): Promise<Response>;
}

function validTrayId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^\S+$/.test(value);
}

class BodyTooLarge extends Error {}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing body');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    ) as unknown;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('body timeout')), BODY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Cancellation must not extend the body deadline for a stalled client.
    void reader.cancel().catch(() => {});
  }
}

/** Transfers through the source owner; never log either controller capability. */
export async function handlePreviewTransfer(
  request: Request,
  sourceTrayId: string,
  getTrayStub: () => TrayStub
): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!validToken(controllerToken)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!validTrayId(sourceTrayId)) return jsonResponse({ error: 'invalid source tray' }, 400);
  let body: unknown;
  try {
    body = await readBody(request);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof BodyTooLarge ? 'body too large' : 'invalid body' },
      error instanceof BodyTooLarge ? 413 : 400
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('targetTrayId' in body) ||
    !validTrayId(body.targetTrayId) ||
    !('targetControllerToken' in body) ||
    !validToken(body.targetControllerToken)
  ) {
    return jsonResponse({ error: 'invalid transfer target' }, 400);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getTrayStub().fetch(
        new Request('https://internal/internal/preview/transfer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            controllerToken,
            targetTrayId: body.targetTrayId,
            targetControllerToken: body.targetControllerToken,
          }),
          signal: controller.signal,
        })
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('transfer timeout'));
        }, TRANSFER_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // The durable transfer may still finish. Retrying the same credentials is
    // idempotent; callers must not discard them on this ambiguous response.
    return jsonResponse({ error: 'preview transfer pending; retry the same target' }, 503);
  } finally {
    clearTimeout(timer);
  }
}
