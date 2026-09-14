import type { Page } from '@playwright/test';
import { BRIDGE_WS_URL, E2E_BRIDGE_TOKEN } from './playwright.config.js';

export function leaderBootQuery(): string {
  const params = new URLSearchParams({
    bridge: BRIDGE_WS_URL,
    bridgeToken: E2E_BRIDGE_TOKEN,
  });
  return params.toString();
}

export async function gotoLeader(
  page: Page,
  path = '/'
): Promise<Awaited<ReturnType<Page['goto']>>> {
  const sep = path.includes('?') ? '&' : '?';
  return page.goto(`${path}${sep}${leaderBootQuery()}`);
}

const SEED_STORAGE_KEY = '__sliccE2EPreviewSeed';

export async function seedSkipSwReload(page: Page): Promise<void> {
  await page.addInitScript((storageKey: string) => {
    try {
      sessionStorage.setItem('slicc-sw-reloaded', '1');
    } catch {}
    try {
      const bc = new BroadcastChannel('preview-vfs');
      bc.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as
          | { type?: string; id?: string; path?: string; asText?: boolean }
          | undefined;
        if (data?.type !== 'preview-vfs-read' || !data.id || !data.path) return;
        let map: Record<string, string> | null = null;
        try {
          const raw = sessionStorage.getItem(storageKey);
          map = raw ? (JSON.parse(raw) as Record<string, string>) : null;
        } catch {
          map = null;
        }
        if (!map || !(data.path in map)) return;
        const content = map[data.path];
        bc.postMessage({ type: 'preview-vfs-response', id: data.id, content });
      });
    } catch {}
  }, SEED_STORAGE_KEY);
}

export async function waitForSW(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers not supported');
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const reg = await navigator.serviceWorker.getRegistration('/preview/');
      if (reg?.active) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Preview SW did not activate within 15s');
  });
}

export async function installVfsFallbackResponder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bc = new BroadcastChannel('preview-vfs');
    bc.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'preview-vfs-read') return;
      bc.postMessage({
        type: 'preview-vfs-response',
        id: event.data.id,
        error: 'ENOENT',
      });
    };
  });
}

export async function seedVFS(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate(
    ({ storageKey, fileMap }: { storageKey: string; fileMap: Record<string, string> }) => {
      sessionStorage.setItem(storageKey, JSON.stringify(fileMap));
    },
    { storageKey: SEED_STORAGE_KEY, fileMap: files }
  );
}
