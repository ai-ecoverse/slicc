/**
 * A preview keeps its original token/URL and immutable serving scope across roves.
 * The token's original tray is its locator, updated directly on every transfer:
 * routing depth never grows with the number of roves. No public redirects or
 * controller capabilities cross the preview response boundary.
 *
 * Transfer freezes the source, imports once, updates locators, then relinquishes
 * ownership. The durable import receipt is deliberately retained after revoke:
 * retrying a lost response must not resurrect a preview. R2 keys and expiry move
 * unchanged; only the current owner runs archive cleanup.
 */
import {
  type DurableObjectNamespaceLike,
  jsonResponse,
  type PreviewRecord,
  parseCapabilityToken,
  type TrayRecord,
} from './shared.js';

interface ContinuityDeps {
  namespace?: DurableObjectNamespaceLike;
  loadTray(): Promise<void>;
  getTray(): TrayRecord | null;
  persistTray(): Promise<void>;
  matchesToken(received: string, expected: string): boolean;
  revoke(token: string): Promise<unknown>;
  transferred(tokens: string[]): Promise<void>;
  imported(): Promise<void>;
}

interface TransferRequest {
  controllerToken: string;
  targetTrayId: string;
  targetControllerToken: string;
}

const busy = () =>
  jsonResponse({ error: 'Preview transfer pending', code: 'PREVIEW_TRANSFER_PENDING' }, 503);
const conflict = () => jsonResponse({ error: 'Preview transfer conflict' }, 409);
const forbidden = () => jsonResponse({ error: 'Invalid controller capability' }, 403);

async function boundedFetch(operation: Promise<Response>): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Preview routing timeout')), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class PreviewContinuity {
  private transferring = false;

  constructor(private readonly deps: ContinuityDeps) {}

  private async call(trayId: string, path: string, body: unknown): Promise<Response> {
    const namespace = this.deps.namespace;
    if (!namespace) throw new Error('Tray routing unavailable');
    return boundedFetch(
      namespace.get(namespace.idFromName(trayId)).fetch(
        new Request(`https://internal/internal/preview/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        })
      )
    );
  }

  async route(url: URL, request: Request): Promise<Response | null> {
    await this.deps.loadTray();
    const tray = this.deps.getTray();
    if (!tray) return null;
    try {
      return await this.dispatch(url, request, tray);
    } catch {
      return jsonResponse(
        { error: 'Preview continuity unavailable; retry the same transfer' },
        503
      );
    }
  }

  private async dispatch(url: URL, request: Request, tray: TrayRecord): Promise<Response | null> {
    const action = url.pathname.slice('/internal/preview/'.length);
    const handoff = await this.handoff(action, request, tray);
    if (handoff) return handoff;
    if (tray.previewTransfer && tray.previewTransfer.phase !== 'complete') return busy();
    if (
      action !== 'stop' &&
      action !== 'revoke-forwarded' &&
      Object.values(tray.previewImports ?? {}).some((receipt) => !receipt.activated)
    )
      return busy();
    if (action === 'mint' && tray.previewTransfer) return conflict();
    if (action === 'list' && tray.previewTransfer) return this.listForwarded(request, tray);

    const body =
      request.method === 'POST'
        ? ((await request.clone().json()) as { previewToken?: string; controllerToken?: string })
        : undefined;
    const token = url.searchParams.get('token') ?? body?.previewToken;
    const destination = token && tray.previewForwarding?.[token];
    if (destination && token) {
      if (
        action === 'stop' &&
        !this.deps.matchesToken(body?.controllerToken ?? '', tray.controllerToken)
      ) {
        return forbidden();
      }
      const forwarded =
        action === 'stop'
          ? new Request('https://internal/internal/preview/revoke-forwarded', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ previewToken: token }),
            })
          : request;
      return this.forward(destination, forwarded);
    }
    if (action === 'revoke-forwarded' && token) {
      return jsonResponse(await this.deps.revoke(token), 200);
    }
    return null;
  }

  private async handoff(
    action: string,
    request: Request,
    tray: TrayRecord
  ): Promise<Response | null> {
    if (request.method !== 'POST') return null;
    switch (action) {
      case 'transfer':
        return this.transfer((await request.json()) as TransferRequest, tray);
      case 'import':
        return this.importRecords((await request.json()) as ImportRequest, tray);
      case 'relocate':
        return this.relocate((await request.json()) as RelocateRequest, tray);
      case 'activate': {
        const body = (await request.json()) as { sourceTrayId: string; id: string };
        const receipt = tray.previewImports?.[body.sourceTrayId];
        if (receipt?.id !== body.id) return conflict();
        // Alarm installation is a separate durable operation from the import
        // receipt. Activation cannot acknowledge ownership without restoring it.
        await this.deps.imported();
        receipt.activated = true;
        await this.deps.persistTray();
        return jsonResponse({ activated: true }, 200);
      }
      default:
        return null;
    }
  }

  private async forward(destination: string, request: Request): Promise<Response> {
    const namespace = this.deps.namespace;
    if (!namespace) return busy();
    // Original locator -> owner is one hop; an old intermediate's management
    // request may first return to the original locator. Fail closed on corruption.
    const hops = Number(request.headers.get('x-slicc-preview-hops') ?? 0);
    if (!Number.isInteger(hops) || hops >= 2) return conflict();
    const headers = new Headers(request.headers);
    headers.set('x-slicc-preview-hops', String(hops + 1));
    const response = await boundedFetch(
      namespace
        .get(namespace.idFromName(destination))
        .fetch(new Request(request, { headers, signal: AbortSignal.timeout(30_000) }))
    );
    const result = new Response(response.body, response);
    result.headers.set(
      'x-slicc-preview-tray',
      response.headers.get('x-slicc-preview-tray') ?? destination
    );
    return result;
  }

  private async listForwarded(request: Request, tray: TrayRecord): Promise<Response> {
    if (
      !this.deps.matchesToken(request.headers.get('x-controller-token') ?? '', tray.controllerToken)
    ) {
      return forbidden();
    }
    const previews: PreviewRecord[] = [];
    for (const [token, destination] of Object.entries(tray.previewForwarding ?? {})) {
      const response = await this.forward(
        destination,
        new Request(`https://internal/internal/preview/resolve?token=${encodeURIComponent(token)}`)
      );
      if (response.ok) previews.push((await response.json()) as PreviewRecord);
      else if (response.status !== 404) return response;
    }
    return jsonResponse({ previews }, 200);
  }

  private async transfer(body: TransferRequest, tray: TrayRecord): Promise<Response> {
    if (!this.deps.matchesToken(body.controllerToken ?? '', tray.controllerToken))
      return forbidden();
    if (!body.targetTrayId || !body.targetControllerToken || body.targetTrayId === tray.trayId)
      return conflict();
    if (
      this.transferring ||
      Object.values(tray.previewImports ?? {}).some((receipt) => !receipt.activated)
    )
      return busy();
    const previous = tray.previewTransfer;
    if (previous && previous.targetTrayId !== body.targetTrayId) return conflict();
    if (previous?.phase === 'complete')
      return jsonResponse({ transferred: true, count: previous.tokens.length }, 200);
    this.transferring = true;
    try {
      // Validate the target before freezing anything. Source ownership was checked
      // above; an attacker holding only one of the controllers cannot move previews.
      const namespace = this.deps.namespace;
      if (!namespace) return busy();
      const confirmed = await boundedFetch(
        namespace.get(namespace.idFromName(body.targetTrayId)).fetch(
          new Request('https://internal/internal/confirm-controller', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ controllerToken: body.targetControllerToken }),
            signal: AbortSignal.timeout(30_000),
          })
        )
      );
      if (!confirmed.ok || ((await confirmed.json()) as { confirmed?: boolean }).confirmed !== true)
        return forbidden();
      const transfer = (tray.previewTransfer ??= {
        id: crypto.randomUUID(),
        targetTrayId: body.targetTrayId,
        tokens: Object.keys(tray.previews ?? {}),
        phase: 'pending',
      });
      await this.deps.persistTray();
      const imported = await this.call(body.targetTrayId, 'import', {
        controllerToken: body.targetControllerToken,
        sourceTrayId: tray.trayId,
        id: transfer.id,
        records: Object.values(tray.previews ?? {}),
      });
      if (!imported.ok) return imported;
      if (transfer.phase === 'pending') {
        const moved = await this.moveLocators(tray, transfer);
        if (moved) return moved;
      }
      await this.deps.transferred(transfer.tokens);
      const activated = await this.call(body.targetTrayId, 'activate', {
        sourceTrayId: tray.trayId,
        id: transfer.id,
      });
      if (!activated.ok) return activated;
      transfer.phase = 'complete';
      await this.deps.persistTray();
      return jsonResponse({ transferred: true, count: transfer.tokens.length }, 200);
    } finally {
      this.transferring = false;
    }
  }

  private async moveLocators(
    tray: TrayRecord,
    transfer: NonNullable<TrayRecord['previewTransfer']>
  ): Promise<Response | null> {
    for (const token of transfer.tokens) {
      const origin = parseCapabilityToken(token)?.trayId;
      if (!origin) return conflict();
      const relocated = await this.call(origin, 'relocate', {
        token,
        sourceTrayId: tray.trayId,
        targetTrayId: transfer.targetTrayId,
      });
      if (!relocated.ok) return relocated;
      (tray.previewForwarding ??= {})[token] =
        origin === tray.trayId ? transfer.targetTrayId : origin;
    }
    // Remove ALL source ownership, including pending R2 uploads and cleanup
    // tombstones. Never delete archive bytes as part of a transfer.
    tray.previews = {};
    transfer.phase = 'forwarded';
    await this.deps.persistTray();
    return null;
  }

  private async importRecords(body: ImportRequest, tray: TrayRecord): Promise<Response> {
    if (!this.deps.matchesToken(body.controllerToken ?? '', tray.controllerToken))
      return forbidden();
    const receipt = tray.previewImports?.[body.sourceTrayId];
    if (receipt) {
      if (receipt.id !== body.id) return conflict();
      // Retry side effects even when the record import was committed. In
      // particular, setAlarm may have failed after persisting this receipt.
      await this.deps.imported();
      return jsonResponse({ imported: true }, 200);
    }
    if (
      tray.previewTransfer ||
      tray.expiredAt ||
      !body.sourceTrayId ||
      !body.id ||
      !Array.isArray(body.records)
    )
      return conflict();
    if (Object.keys(tray.previews ?? {}).length + body.records.length > 10) return conflict();
    for (const record of body.records) {
      if (
        !parseCapabilityToken(record.previewToken) ||
        tray.previews?.[record.previewToken] ||
        tray.previewForwarding?.[record.previewToken]
      )
        return conflict();
    }
    for (const record of body.records) (tray.previews ??= {})[record.previewToken] = record;
    (tray.previewImports ??= {})[body.sourceTrayId] = { id: body.id, activated: false };
    await this.deps.persistTray();
    await this.deps.imported();
    return jsonResponse({ imported: true }, 200);
  }

  private async relocate(body: RelocateRequest, tray: TrayRecord): Promise<Response> {
    if (
      parseCapabilityToken(body.token)?.trayId !== tray.trayId ||
      body.targetTrayId === tray.trayId
    )
      return conflict();
    const current = tray.previewForwarding?.[body.token];
    if (current === body.targetTrayId) return jsonResponse({ relocated: true }, 200);
    const initial =
      !current &&
      tray.previews?.[body.token] &&
      body.sourceTrayId === tray.trayId &&
      tray.previewTransfer?.targetTrayId === body.targetTrayId;
    if (!initial && current !== body.sourceTrayId) return conflict();
    (tray.previewForwarding ??= {})[body.token] = body.targetTrayId;
    await this.deps.persistTray();
    return jsonResponse({ relocated: true }, 200);
  }
}

interface ImportRequest {
  controllerToken: string;
  sourceTrayId: string;
  id: string;
  records: PreviewRecord[];
}

interface RelocateRequest {
  token: string;
  sourceTrayId: string;
  targetTrayId: string;
}
