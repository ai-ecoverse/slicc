/**
 * Small fetch wrappers for the worker's preview mint/stop/list HTTP API.
 *
 * Both standalone (`tray-open-preview` panel-RPC op) and extension
 * (`setPreviewMinter` hook) call these. The shapes mirror the worker
 * routes added in Task 5.
 *
 * Wire shapes are intentionally defined locally — webapp has no
 * dependency on `@slicc/cloudflare-worker`, and the contract is small.
 */

export interface MintArgs {
  workerBaseUrl: string;
  trayId: string;
  controllerToken: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  bridge?: boolean;
  maxTabs?: number;
  webhookId?: string;
}

export interface PreviewListItem {
  previewToken: string;
  url: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  createdAt: string;
}

export async function mintPreviewViaWorker(
  args: MintArgs,
  fetchImpl: typeof fetch = fetch
): Promise<{ previewToken: string; url: string }> {
  const url = `${args.workerBaseUrl}/api/tray/${encodeURIComponent(args.trayId)}/preview`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.controllerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      servedRoot: args.servedRoot,
      entryPath: args.entryPath,
      allowLive: args.allowLive,
      bridge: args.bridge,
      maxTabs: args.maxTabs,
      webhookId: args.webhookId,
    }),
  });
  if (!res.ok) throw new Error(`Preview mint failed: ${res.status}`);
  return res.json() as Promise<{ previewToken: string; url: string }>;
}

export async function revokePreviewViaWorker(
  args: {
    workerBaseUrl: string;
    trayId: string;
    controllerToken: string;
    previewToken: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<{ revoked: boolean; webhookId?: string }> {
  const url = `${args.workerBaseUrl}/api/tray/${encodeURIComponent(args.trayId)}/preview/stop`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.controllerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ previewToken: args.previewToken }),
  });
  if (!res.ok) throw new Error(`Preview revoke failed: ${res.status}`);
  return res.json() as Promise<{ revoked: boolean; webhookId?: string }>;
}

export async function listPreviewsViaWorker(
  args: { workerBaseUrl: string; trayId: string; controllerToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ previews: PreviewListItem[] }> {
  const url = `${args.workerBaseUrl}/api/tray/${encodeURIComponent(args.trayId)}/previews`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.controllerToken}` },
  });
  if (!res.ok) throw new Error(`Preview list failed: ${res.status}`);
  return res.json() as Promise<{ previews: PreviewListItem[] }>;
}
