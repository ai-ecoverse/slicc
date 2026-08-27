/**
 * Biscotto seat lifecycle — mint, revoke, list.
 *
 * A *biscotto* is a revocable guest seat on a cone: the holder of its token
 * gets a private URL that renders the live transcript and, subject to the
 * seat's gates, can send messages. Resolution of the token back to a seat is
 * NOT here — it is `resolveJoinCapability` in `shared.ts`, on the join path,
 * because that is the single default-deny point for the whole join surface.
 *
 * Structured like `session-tray-preview.ts`: every function takes explicit
 * dependencies rather than reaching into the durable object, so the DO keeps
 * thin delegation wrappers and these stay unit-testable without a DO harness.
 *
 * Minting is authenticated by the tray's **controller** token, i.e. only the
 * leader can hand out seats. A seat can never mint another seat.
 */

import {
  type BiscottoGate,
  type BiscottoGates,
  type BiscottoRecord,
  createCapabilityToken,
  MAX_BISCOTTI_PER_TRAY,
  normalizeBiscottoGate,
  type TrayRecord,
} from './shared.js';

/** The slice of the durable object these helpers need. */
export interface BiscottoDeps {
  loadTray(): Promise<void>;
  getTray(): TrayRecord | null;
  persistTray(): Promise<void>;
  isoNow(): string;
  now(): number;
  matchesToken(received: string, expected: string): boolean;
}

/** An error carrying the HTTP status the route should answer with. */
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
  /** Human label for the guest, e.g. `Anna`. Rendered as message attribution. */
  label: string;
  workerBaseUrl: string;
  /** Lifetime in ms. Omitted = lives as long as the tray. */
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

/**
 * Public shape of a seat. Deliberately WITHOUT `token`: `biscotti` prints this
 * and a listing that echoed live capabilities would turn any transcript, log
 * or screenshot of the list into a set of working guest URLs.
 */
export interface BiscottoSummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastSeenAt?: string;
  gates: BiscottoGates;
  /** False once revoked or past expiry — precomputed so callers don't re-derive the clock. */
  active: boolean;
}

/** Longest a seat may live. Matches the persistent-preview ceiling. */
export const MAX_BISCOTTO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Labels ride into chat attribution, so keep them short and single-line. */
const MAX_LABEL_LENGTH = 64;

function requireTray(deps: BiscottoDeps): TrayRecord {
  const tray = deps.getTray();
  if (!tray) throw new BiscottoRouteError('Tray not loaded', 500);
  return tray;
}

function assertController(tray: TrayRecord, deps: BiscottoDeps, controllerToken: string): void {
  if (!deps.matchesToken(controllerToken, tray.controllerToken)) {
    throw new BiscottoRouteError('Invalid controller capability', 403);
  }
}

/**
 * Whether a seat still resolves. Mirrors the liveness half of
 * `resolveJoinCapability` — kept as one predicate so the listing can never
 * disagree with what the join path will actually accept.
 */
export function isBiscottoActive(record: BiscottoRecord, now: number): boolean {
  if (record.revokedAt) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return false;
  return true;
}

/**
 * Strip a label to something safe to render as an attribution chip: no control
 * characters (they break log lines and can spoof structure in a transcript),
 * collapsed whitespace, bounded length.
 */
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

/**
 * Mint a guest seat and return its private URL.
 *
 * The URL reuses the preview subdomain encoding (`<trayId>--<secret>.sliccy.now`)
 * so a seat gets an origin of its own rather than a query parameter on the
 * app origin. The token therefore never appears in a `Referer`, and the page
 * can read it back off its own hostname.
 */
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

/**
 * Revoke a seat by id. Idempotent: revoking an already-revoked seat succeeds
 * and leaves the original `revokedAt` intact, so the audit trail records when
 * access actually ended rather than when someone last typed the command.
 */
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

/** List every seat ever minted on this tray, newest last. Tokens are not included. */
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
