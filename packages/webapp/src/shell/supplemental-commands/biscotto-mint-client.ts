/**
 * Fetch wrappers for the worker's biscotto mint/revoke/list HTTP API.
 *
 * Mirrors `preview-mint-client.ts`. Wire shapes are defined locally on purpose:
 * webapp has no dependency on `@slicc/cloudflare-worker`, and the contract is
 * small enough that duplicating it beats coupling the packages.
 *
 * Every route is authenticated with the tray's CONTROLLER token — only the
 * leader mints or revokes a seat, and a seat is never an issuing authority.
 */

import type { FollowerBiscottoGate, FollowerBiscottoGates } from '@slicc/shared-ts';

/** A seat as the worker reports it. Deliberately WITHOUT its token. */
export interface BiscottoListItem {
  id: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastSeenAt?: string;
  gates: BiscottoGatesWire;
  /** False once revoked or past expiry. */
  active: boolean;
}

/**
 * Re-exported from the wire package rather than restated. An approver tier
 * added there must not be able to exist on one side of this boundary and not
 * the other — restating the union is how `approver` was silently dropped once
 * already.
 */
export type BiscottoGatesWire = FollowerBiscottoGates;
export type BiscottoGateWire = FollowerBiscottoGate;

export interface MintBiscottoArgs {
  workerBaseUrl: string;
  trayId: string;
  controllerToken: string;
  label: string;
  ttlMs?: number;
  gates?: BiscottoGatesWire;
}

export interface MintBiscottoResult {
  id: string;
  /** The private guest URL. Printed ONCE, at mint; never recoverable from a list. */
  url: string;
  label: string;
  expiresAt?: string;
  gates: BiscottoGatesWire;
}

async function workerError(prefix: string, response: Response): Promise<Error> {
  try {
    const body = (await response.clone().json()) as { error?: string };
    if (body.error) return new Error(`${prefix}: ${body.error}`);
  } catch {
    // Fall through to the status-only error.
  }
  return new Error(`${prefix}: ${response.status}`);
}

function trayUrl(base: string, trayId: string, suffix: string): string {
  return `${base}/api/tray/${encodeURIComponent(trayId)}/${suffix}`;
}

export async function mintBiscottoViaWorker(
  args: MintBiscottoArgs,
  fetchImpl: typeof fetch = fetch
): Promise<MintBiscottoResult> {
  const res = await fetchImpl(trayUrl(args.workerBaseUrl, args.trayId, 'biscotto'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.controllerToken}`,
      'Content-Type': 'application/json',
    },
    // Forwarded as a whole object rather than rebuilt field-by-field: a
    // rebuild here is exactly how `approver` and `requester` were silently
    // dropped elsewhere in this feature.
    body: JSON.stringify({ label: args.label, ttlMs: args.ttlMs, gates: args.gates }),
  });
  if (!res.ok) throw await workerError('Biscotto mint failed', res);
  return res.json() as Promise<MintBiscottoResult>;
}

export async function revokeBiscottoViaWorker(
  args: { workerBaseUrl: string; trayId: string; controllerToken: string; id: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string; active: boolean; revokedAt?: string; evicted?: boolean }> {
  const res = await fetchImpl(trayUrl(args.workerBaseUrl, args.trayId, 'biscotto/stop'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.controllerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: args.id }),
  });
  if (!res.ok) throw await workerError('Biscotto revoke failed', res);
  return res.json() as Promise<{
    id: string;
    active: boolean;
    revokedAt?: string;
    evicted?: boolean;
  }>;
}

export async function listBiscottiViaWorker(
  args: { workerBaseUrl: string; trayId: string; controllerToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ biscotti: BiscottoListItem[] }> {
  const res = await fetchImpl(trayUrl(args.workerBaseUrl, args.trayId, 'biscotti'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.controllerToken}` },
  });
  if (!res.ok) throw await workerError('Biscotti list failed', res);
  return res.json() as Promise<{ biscotti: BiscottoListItem[] }>;
}
