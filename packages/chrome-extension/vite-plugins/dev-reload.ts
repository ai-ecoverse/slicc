import type { Dirent } from 'node:fs';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import * as http from 'node:http';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { WebSocket } from 'ws';

export interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface DevReloadOptions {
  outDir: string;

  syncTo: string;

  cdpPort: number;

  extraWatchDirs: readonly string[];
}

export function listFilesRecursive(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function syncExtensionDir(outDir: string, syncTo: string): void {
  if (resolve(outDir) === resolve(syncTo)) return;
  mkdirSync(syncTo, { recursive: true });
  cpSync(outDir, syncTo, { recursive: true, force: true });
}

export function pickServiceWorkerTarget(targets: readonly CdpTarget[]): CdpTarget | null {
  const matches = targets.filter(
    (t) => typeof t.url === 'string' && t.url.endsWith('/service-worker.js')
  );
  if (matches.length !== 1) return null;
  const sw = matches[0];
  return sw && typeof sw.webSocketDebuggerUrl === 'string' ? sw : null;
}

export function buildReloadExpression(): string {
  return `(() => {
    try { chrome.runtime.reload(); } catch {}
    return 'reload-scheduled';
  })()`;
}

function fetchCdpJson<T>(port: number, path: string, timeoutMs = 1500): Promise<T> {
  return new Promise((resolveJson, reject) => {
    const req = http.get({ host: 'localhost', port, path, timeout: timeoutMs }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} on ${path}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolveJson(JSON.parse(body) as T);
        } catch (err) {
          reject(new Error(`bad JSON on ${path}: ${(err as Error).message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout on ${path}`));
    });
  });
}

async function evaluateOnTarget(wsUrl: string, expression: string): Promise<void> {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise<void>((resolveOpen, reject) => {
    const onOpen = () => {
      ws.off('error', onError);
      resolveOpen();
    };
    const onError = (err: Error) => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
  try {
    const id = 1;
    const reply = await new Promise<{ error?: { message?: string } }>((resolveReply, reject) => {
      const onMessage = (raw: Buffer | ArrayBuffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as { id?: number; error?: { message?: string } };
          if (msg.id === id) {
            ws.off('message', onMessage);
            resolveReply(msg);
          }
        } catch {}
      };
      ws.on('message', onMessage);
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: false },
        }),
        (err) => {
          if (err) reject(err);
        }
      );
    });
    if (reply.error) {
      throw new Error(reply.error.message ?? 'unknown CDP error');
    }
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

export function pickExtensionReloadTarget(
  targets: readonly CdpTarget[]
): { target: CdpTarget; viaServiceWorker: boolean } | null {
  const sw = pickServiceWorkerTarget(targets);
  if (sw) return { target: sw, viaServiceWorker: true };
  const extTarget = targets.find(
    (t) =>
      typeof t.url === 'string' &&
      t.url.startsWith('chrome-extension://') &&
      typeof t.webSocketDebuggerUrl === 'string'
  );
  return extTarget ? { target: extTarget, viaServiceWorker: false } : null;
}

async function triggerCdpReload(port: number): Promise<string> {
  await fetchCdpJson(port, '/json/version');
  let pick: ReturnType<typeof pickExtensionReloadTarget> = null;
  let lastTotal = 0;
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const targets = await fetchCdpJson<CdpTarget[]>(port, '/json/list');
    lastTotal = targets.length;
    pick = pickExtensionReloadTarget(targets);
    if (pick) break;
    if (attempt < maxAttempts - 1) {
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }
  if (!pick?.target.webSocketDebuggerUrl) {
    throw new Error(
      `no extension target on /json/list ` +
        `(probed ${maxAttempts}× over ~1s, saw ${lastTotal} targets) — extension not loaded?`
    );
  }

  await evaluateOnTarget(pick.target.webSocketDebuggerUrl, buildReloadExpression());
  return pick.viaServiceWorker ? 'service-worker' : 'extension-page';
}

export function devReloadPlugin(opts: DevReloadOptions): Plugin {
  let buildCount = 0;
  return {
    name: 'slicc:dev-reload',
    apply: 'build',
    buildStart() {
      for (const dir of opts.extraWatchDirs) {
        for (const file of listFilesRecursive(dir)) {
          this.addWatchFile(file);
        }
      }
    },
    async closeBundle() {
      buildCount++;
      try {
        syncExtensionDir(opts.outDir, opts.syncTo);
      } catch (err) {
        console.warn(`[dev-reload] sync failed: ${(err as Error).message}`);
        return;
      }
      const tag = buildCount === 1 ? 'initial build' : `rebuild #${buildCount - 1}`;
      console.log(`[dev-reload] synced ${opts.outDir} → ${opts.syncTo} (${tag})`);
      try {
        const via = await triggerCdpReload(opts.cdpPort);
        console.log(
          `[dev-reload] dispatched chrome.runtime.reload() via ${via} ` +
            `(port ${opts.cdpPort}) — reopen the side panel to pick up new panel code`
        );
      } catch (err) {
        console.warn(
          `[dev-reload] CDP reload skipped: ${(err as Error).message} — ` +
            `start Chrome for Testing on port ${opts.cdpPort} ` +
            `(see packages/chrome-extension/CLAUDE.md "Local QA" recipe)`
        );
      }
    },
  };
}
