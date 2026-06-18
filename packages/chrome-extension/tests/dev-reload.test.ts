import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReloadExpression,
  type CdpTarget,
  listFilesRecursive,
  pickExtensionReloadTarget,
  pickServiceWorkerTarget,
  syncExtensionDir,
} from '../vite-plugins/dev-reload';

describe('dev-reload helpers', () => {
  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const mkTmp = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-dev-reload-'));
    tmpRoots.push(root);
    return root;
  };

  describe('syncExtensionDir', () => {
    it('mirrors a populated outDir into a fresh syncTo', () => {
      const root = mkTmp();
      const outDir = join(root, 'dist');
      const syncTo = join(root, 'mirror');
      mkdirSync(join(outDir, 'sub'), { recursive: true });
      writeFileSync(join(outDir, 'manifest.json'), '{"v":1}');
      writeFileSync(join(outDir, 'sub', 'content-script.js'), '// content');

      syncExtensionDir(outDir, syncTo);

      expect(readFileSync(join(syncTo, 'manifest.json'), 'utf8')).toBe('{"v":1}');
      expect(readFileSync(join(syncTo, 'sub', 'content-script.js'), 'utf8')).toBe('// content');
    });

    it('overlays new files onto the destination without nuking unrelated content', () => {
      // Overlay (not replace) so Chrome's --load-extension path stays
      // continuously valid — wiping the destination would briefly evict
      // the extension service-worker the next CDP reload needs.
      const root = mkTmp();
      const outDir = join(root, 'dist');
      const syncTo = join(root, 'mirror');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'kept.js'), 'new');

      mkdirSync(syncTo, { recursive: true });
      writeFileSync(join(syncTo, 'kept.js'), 'old');
      writeFileSync(join(syncTo, 'orphan.js'), 'stale');

      syncExtensionDir(outDir, syncTo);

      expect(readFileSync(join(syncTo, 'kept.js'), 'utf8')).toBe('new');
      // Orphans linger by design (they're harmless — the manifest in the
      // overlay-copied set never references them).
      expect(readFileSync(join(syncTo, 'orphan.js'), 'utf8')).toBe('stale');
    });

    it('is a no-op when syncTo equals outDir', () => {
      const root = mkTmp();
      const outDir = join(root, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'a.js'), 'x');

      // Pass the same path twice via slightly different representations to
      // exercise the resolve() equality check.
      syncExtensionDir(outDir, resolve(outDir, '.'));

      expect(readFileSync(join(outDir, 'a.js'), 'utf8')).toBe('x');
    });
  });

  describe('pickServiceWorkerTarget', () => {
    it('returns the unique service-worker target', () => {
      const targets: CdpTarget[] = [
        { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://pg' },
        {
          type: 'service_worker',
          url: 'chrome-extension://abc/service-worker.js',
          webSocketDebuggerUrl: 'ws://sw',
        },
      ];
      const sw = pickServiceWorkerTarget(targets);
      expect(sw?.webSocketDebuggerUrl).toBe('ws://sw');
    });

    it('returns null when no service-worker target is present', () => {
      const targets: CdpTarget[] = [
        { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://pg' },
      ];
      expect(pickServiceWorkerTarget(targets)).toBeNull();
    });

    it('returns null when more than one service-worker target is present', () => {
      const targets: CdpTarget[] = [
        {
          type: 'service_worker',
          url: 'chrome-extension://aaa/service-worker.js',
          webSocketDebuggerUrl: 'ws://sw1',
        },
        {
          type: 'service_worker',
          url: 'chrome-extension://bbb/service-worker.js',
          webSocketDebuggerUrl: 'ws://sw2',
        },
      ];
      expect(pickServiceWorkerTarget(targets)).toBeNull();
    });

    it('returns null when the matching target has no webSocketDebuggerUrl', () => {
      const targets: CdpTarget[] = [
        { type: 'service_worker', url: 'chrome-extension://abc/service-worker.js' },
      ];
      expect(pickServiceWorkerTarget(targets)).toBeNull();
    });
  });

  describe('pickExtensionReloadTarget', () => {
    it('prefers the service-worker target when present', () => {
      const targets: CdpTarget[] = [
        {
          type: 'background_page',
          url: 'chrome-extension://abc/offscreen.html',
          webSocketDebuggerUrl: 'ws://off',
        },
        {
          type: 'service_worker',
          url: 'chrome-extension://abc/service-worker.js',
          webSocketDebuggerUrl: 'ws://sw',
        },
      ];
      const pick = pickExtensionReloadTarget(targets);
      expect(pick?.viaServiceWorker).toBe(true);
      expect(pick?.target.webSocketDebuggerUrl).toBe('ws://sw');
    });

    it('falls back to a non-SW extension target when the SW is idle', () => {
      // MV3 SWs evict after 30s with no events and `/json/list` does not
      // wake them. The offscreen / options page is still a valid lever for
      // `chrome.runtime.reload()`.
      const targets: CdpTarget[] = [
        { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://pg' },
        {
          type: 'background_page',
          url: 'chrome-extension://abc/offscreen.html',
          webSocketDebuggerUrl: 'ws://off',
        },
      ];
      const pick = pickExtensionReloadTarget(targets);
      expect(pick?.viaServiceWorker).toBe(false);
      expect(pick?.target.webSocketDebuggerUrl).toBe('ws://off');
    });

    it('returns null when no extension target is present', () => {
      const targets: CdpTarget[] = [
        { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://pg' },
      ];
      expect(pickExtensionReloadTarget(targets)).toBeNull();
    });
  });

  describe('listFilesRecursive', () => {
    it('returns every file under the root, including nested subdirs', () => {
      const root = mkTmp();
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      writeFileSync(join(root, 'top.ts'), '');
      writeFileSync(join(root, 'a', 'mid.ts'), '');
      writeFileSync(join(root, 'a', 'b', 'leaf.ts'), '');

      const files = listFilesRecursive(root)
        .map((f) => f.slice(root.length + 1))
        .sort();
      expect(files).toEqual([join('a', 'b', 'leaf.ts'), join('a', 'mid.ts'), 'top.ts']);
    });

    it('returns an empty array for a missing directory', () => {
      expect(listFilesRecursive(join(mkTmp(), 'does-not-exist'))).toEqual([]);
    });
  });

  describe('buildReloadExpression', () => {
    it('reloads the extension and tolerates a missing chrome.runtime', () => {
      const expr = buildReloadExpression();
      expect(expr).toContain('chrome.runtime.reload()');
      // The expression is wrapped in try/catch so a Runtime.evaluate call
      // against a target that briefly has no chrome.runtime can't reject.
      expect(expr).toContain('try');
      expect(expr).toContain('catch');
    });

    it('does NOT reload page tabs (avoids the disable-during-restart race)', () => {
      const expr = buildReloadExpression();
      expect(expr).not.toContain('chrome.tabs.reload');
      expect(expr).not.toContain('chrome.tabs.query');
    });
  });
});
