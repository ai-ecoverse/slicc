// packages/webapp/tests/e2e/helpers.ts
import { type Page } from '@playwright/test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const LFS_SCRIPT = require.resolve('@isomorphic-git/lightning-fs/dist/lightning-fs.min.js');

/** Minimal interface for the LightningFS promises API used in seedVFS. */
interface LightningFSPromises {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Shape of the LightningFS constructor exposed on window by the UMD bundle. */
interface LightningFSConstructor {
  new (dbName: string): { promises: LightningFSPromises };
}

/**
 * Wait for the preview service worker to be registered and active.
 * Must be called after page.goto('/') — the main app registers the SW on load.
 *
 * The SW is registered with scope '/preview/', so navigator.serviceWorker.ready
 * (which waits for a SW controlling the current page at '/') would hang forever.
 * Instead we poll getRegistration() for the '/preview/' scope.
 */
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

/**
 * Install a BroadcastChannel responder that immediately replies with ENOENT
 * for any preview-vfs-read request. Without this, the SW's BroadcastChannel
 * fallback waits 5s before timing out on every 404 — adding ~5s per missing file.
 */
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

/**
 * Seed files into LightningFS IndexedDB (database 'slicc-fs').
 * The preview SW reads from this same database.
 * Must be called after the page has loaded (needs a page context to evaluate JS).
 */
export async function seedVFS(page: Page, files: Record<string, string>): Promise<void> {
  await page.addScriptTag({ path: LFS_SCRIPT });
  await page.evaluate(async (fileMap: Record<string, string>) => {
    const LFS = (window as Window & { LightningFS: LightningFSConstructor }).LightningFS;
    const fs = new LFS('slicc-fs').promises;
    for (const [filePath, content] of Object.entries(fileMap)) {
      const parts = filePath.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const dir = '/' + parts.slice(0, i).join('/');
        try {
          await fs.mkdir(dir);
        } catch {
          /* directory already exists */
        }
      }
      await fs.writeFile(filePath, content);
    }
  }, files);
}
