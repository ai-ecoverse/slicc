import type { FollowerBiscottoGate, FollowerBiscottoGates } from '@slicc/shared-ts';

export interface BiscottoListItem {
  id: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastSeenAt?: string;
  gates: BiscottoGatesWire;

  active: boolean;
}

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

  url: string;
  label: string;
  expiresAt?: string;
  gates: BiscottoGatesWire;
}

async function workerError(prefix: string, response: Response): Promise<Error> {
  try {
    const body = (await response.clone().json()) as { error?: string };
    if (body.error) return new Error(`${prefix}: ${body.error}`);
  } catch {}
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
