import {
  type BiscottoGate,
  type BiscottoGates,
  type BiscottoRecord,
  createCapabilityToken,
  jsonResponse,
  MAX_BISCOTTI_PER_TRAY,
  normalizeBiscottoGate,
  type TrayRecord,
} from './shared.js';

export interface BiscottoDeps {
  loadTray(): Promise<void>;
  getTray(): TrayRecord | null;
  persistTray(): Promise<void>;
  isoNow(): string;
  now(): number;
  matchesToken(received: string, expected: string): boolean;
}

export class BiscottoRouteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface MintBiscottoRequest {
  controllerToken: string;

  label: string;
  workerBaseUrl: string;

  ttlMs?: number;
  gates?: Partial<BiscottoGates>;
}

export interface MintBiscottoResult {
  id: string;
  url: string;
  label: string;
  expiresAt?: string;
  gates: BiscottoGates;
}

export interface BiscottoSummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastSeenAt?: string;
  gates: BiscottoGates;

  active: boolean;
}

export const MAX_BISCOTTO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_LABEL_LENGTH = 64;

function requireTray(deps: BiscottoDeps): TrayRecord {
  const tray = deps.getTray();
  if (!tray) throw new BiscottoRouteError('Invalid controller capability', 403);
  return tray;
}

function assertController(tray: TrayRecord, deps: BiscottoDeps, controllerToken: string): void {
  if (!deps.matchesToken(controllerToken, tray.controllerToken)) {
    throw new BiscottoRouteError('Invalid controller capability', 403);
  }
}

export function isBiscottoActive(record: BiscottoRecord, now: number): boolean {
  if (record.revokedAt) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
  return true;
}

function sanitizeLabel(raw: string): string {
  const flattened = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) {
    throw new BiscottoRouteError('label must not be empty', 400);
  }
  return flattened.slice(0, MAX_LABEL_LENGTH);
}

function normalizeGates(gates: Partial<BiscottoGates> | undefined): BiscottoGates {
  return {
    message: normalizeBiscottoGate(gates?.message as Partial<BiscottoGate> | undefined),
    tool: normalizeBiscottoGate(gates?.tool as Partial<BiscottoGate> | undefined),
  };
}

export async function mintBiscotto(
  req: MintBiscottoRequest,
  deps: BiscottoDeps
): Promise<MintBiscottoResult> {
  await deps.loadTray();
  const tray = requireTray(deps);
  assertController(tray, deps, req.controllerToken);

  const label = sanitizeLabel(req.label ?? '');
  if (req.ttlMs !== undefined) {
    if (!Number.isSafeInteger(req.ttlMs) || req.ttlMs <= 0) {
      throw new BiscottoRouteError('--expires must be a positive duration', 400);
    }
    if (req.ttlMs > MAX_BISCOTTO_TTL_MS) {
      throw new BiscottoRouteError('--expires cannot exceed 30d', 400);
    }
  }

  tray.biscotti ??= [];
  const live = tray.biscotti.filter((entry) => isBiscottoActive(entry, deps.now()));
  if (live.length >= MAX_BISCOTTI_PER_TRAY) {
    throw new BiscottoRouteError(
      `this cone already has ${MAX_BISCOTTI_PER_TRAY} live biscotti; revoke one first`,
      429
    );
  }

  const { buildPreviewUrl } = await import('@slicc/shared-ts');
  const token = createCapabilityToken(tray.trayId, 10);
  const record: BiscottoRecord = {
    id: crypto.randomUUID().slice(0, 8),
    token,
    label,
    createdAt: deps.isoNow(),
    expiresAt: req.ttlMs === undefined ? undefined : new Date(deps.now() + req.ttlMs).toISOString(),
    gates: normalizeGates(req.gates),
  };
  tray.biscotti.push(record);
  await deps.persistTray();

  return {
    id: record.id,
    url: buildPreviewUrl(req.workerBaseUrl, token, '/'),
    label: record.label,
    expiresAt: record.expiresAt,
    gates: record.gates,
  };
}

export async function revokeBiscotto(
  req: { controllerToken: string; id: string },
  deps: BiscottoDeps
): Promise<BiscottoSummary> {
  await deps.loadTray();
  const tray = requireTray(deps);
  assertController(tray, deps, req.controllerToken);

  const record = (tray.biscotti ?? []).find((entry) => entry.id === req.id);
  if (!record) {
    throw new BiscottoRouteError(`no biscotto with id ${req.id}`, 404);
  }
  record.revokedAt ??= deps.isoNow();
  await deps.persistTray();
  return summarize(record, deps.now());
}

export async function listBiscotti(
  req: { controllerToken: string },
  deps: BiscottoDeps
): Promise<BiscottoSummary[]> {
  await deps.loadTray();
  const tray = requireTray(deps);
  assertController(tray, deps, req.controllerToken);
  const now = deps.now();
  return (tray.biscotti ?? []).map((record) => summarize(record, now));
}

function summarize(record: BiscottoRecord, now: number): BiscottoSummary {
  return {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastSeenAt: record.lastSeenAt,
    gates: record.gates,
    active: isBiscottoActive(record, now),
  };
}

export async function dispatchBiscottoRoute(
  url: URL,
  request: Request,
  deps: BiscottoDeps,
  announceRevocation: (biscottoId: string) => boolean
): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }
  let body: {
    controllerToken?: string;
    label?: string;
    id?: string;
    ttlMs?: number;
    gates?: Partial<BiscottoGates>;
    workerBaseUrl?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  const controllerToken = typeof body.controllerToken === 'string' ? body.controllerToken : '';
  try {
    switch (url.pathname) {
      case '/internal/biscotto/mint':
        return jsonResponse(
          await mintBiscotto(
            {
              controllerToken,
              label: body.label ?? '',
              ttlMs: body.ttlMs,
              gates: body.gates,
              workerBaseUrl: body.workerBaseUrl ?? '',
            },
            deps
          )
        );
      case '/internal/biscotto/stop': {
        const revoked = await revokeBiscotto({ controllerToken, id: body.id ?? '' }, deps);

        const evicted = announceRevocation(revoked.id);
        if (!evicted) {
          console.warn('[tray] biscotto revoked but the leader could not be told', {
            biscottoId: revoked.id,
          });
        }
        return jsonResponse({ ...revoked, evicted });
      }
      case '/internal/biscotto/list':
        return jsonResponse({ biscotti: await listBiscotti({ controllerToken }, deps) });
      default:
        return jsonResponse({ error: 'not found' }, 404);
    }
  } catch (error) {
    if (error instanceof BiscottoRouteError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    return jsonResponse({ error: 'biscotto request failed' }, 500);
  }
}
