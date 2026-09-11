import type { WorkerEnv } from './index.js';

/** Management-only route. Delivery capabilities are never accepted as authority. */
export async function handleWebhookRevoke(
  request: Request,
  env: WorkerEnv,
  coneId: string,
  encodedWebhookId: string
): Promise<Response> {
  const reply = (status: number, body: object) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  let body: { rebindSecret?: unknown; trayId?: unknown; controllerToken?: unknown };
  let webhookId: string;
  try {
    webhookId = decodeURIComponent(encodedWebhookId);
    body = JSON.parse(await readManagementBody(request));
    if (
      !webhookId ||
      webhookId.length > 1024 ||
      !body ||
      typeof body.rebindSecret !== 'string' ||
      !body.rebindSecret ||
      typeof body.trayId !== 'string' ||
      !body.trayId ||
      typeof body.controllerToken !== 'string' ||
      !body.controllerToken
    )
      return reply(400, { error: 'Invalid revocation request', code: 'INVALID_BODY' });
  } catch {
    return reply(400, { error: 'Invalid revocation request', code: 'INVALID_BODY' });
  }
  try {
    const home = env.WEBHOOK_HOMES.get(env.WEBHOOK_HOMES.idFromName(coneId));
    const signal = AbortSignal.timeout(15_000);
    const response = await Promise.race([
      home.fetch(
        new Request(new URL('/internal/home/revoke-registration', request.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, webhookId }),
          signal,
        })
      ),
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      }),
    ]);
    if (!response.ok) {
      return reply(response.status === 403 ? 403 : 502, {
        error: 'Webhook revocation failed',
        code: 'WEBHOOK_REVOCATION_FAILED',
      });
    }
    return reply(200, { ok: true });
  } catch {
    return reply(502, { error: 'Webhook revocation failed', code: 'WEBHOOK_REVOCATION_FAILED' });
  }
}

async function readManagementBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing body');
  const signal = AbortSignal.timeout(5_000);
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) return result + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new Error('body too large');
      result += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
