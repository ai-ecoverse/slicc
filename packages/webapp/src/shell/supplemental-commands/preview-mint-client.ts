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
  userHash?: string;
  quiet?: boolean;
  ttlMs?: number;
  snapshotFiles?: PreviewSnapshotFile[];
}

export interface PreviewSnapshotFile {
  path: string;
  content: Uint8Array;
  mime: string;
}

const PREVIEW_UPLOAD_CONCURRENCY = 4;

export interface PreviewListItem {
  previewToken: string;
  url: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  createdAt: string;
  userHash?: string;
  mode?: 'live' | 'persistent';
  expiresAt?: string;
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

async function uploadSnapshotFiles(
  files: PreviewSnapshotFile[],
  upload: (file: PreviewSnapshotFile) => Promise<void>
): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < files.length) {
      const file = files[next++];
      if (!file) continue;
      try {
        await upload(file);
      } catch (err) {
        failure = err;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PREVIEW_UPLOAD_CONCURRENCY, files.length) }, () => worker())
  );
  if (failure !== undefined) throw failure;
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
      userHash: args.userHash,
      quiet: args.quiet,
      ttlMs: args.ttlMs,
    }),
  });
  if (!res.ok) throw await workerError('Preview mint failed', res);
  const minted = (await res.json()) as {
    previewToken: string;
    url: string;
    uploadToken?: string;
  };
  if (args.ttlMs === undefined) return minted;
  try {
    if (!minted.uploadToken) throw new Error('Preview mint failed: upload capability missing');
    await uploadSnapshotFiles(args.snapshotFiles ?? [], async (file) => {
      const uploadUrl =
        `${url}/${encodeURIComponent(minted.previewToken)}/file?path=` +
        encodeURIComponent(file.path);
      const upload = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${minted.uploadToken}`,
          'Content-Type': file.mime,
        },
        body: new Uint8Array(file.content).buffer,
      });
      if (!upload.ok) throw await workerError(`Preview upload failed for ${file.path}`, upload);
    });
    const finalize = await fetchImpl(`${url}/${encodeURIComponent(minted.previewToken)}/finalize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.uploadToken}` },
    });
    if (!finalize.ok) throw await workerError('Preview finalize failed', finalize);
    return (await finalize.json()) as { previewToken: string; url: string };
  } catch (err) {
    await revokePreviewViaWorker(
      {
        workerBaseUrl: args.workerBaseUrl,
        trayId: args.trayId,
        controllerToken: args.controllerToken,
        previewToken: minted.previewToken,
      },
      fetchImpl
    ).catch(() => {});
    throw err;
  }
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
  if (!res.ok) throw await workerError('Preview revoke failed', res);
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
  if (!res.ok) throw await workerError('Preview list failed', res);
  return res.json() as Promise<{ previews: PreviewListItem[] }>;
}
