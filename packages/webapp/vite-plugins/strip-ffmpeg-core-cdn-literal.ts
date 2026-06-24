/**
 * Vite build plugin: strip the leftover `https://unpkg.com/@ffmpeg/core@…
 * /ffmpeg-core.js` literal that `@ffmpeg/ffmpeg/dist/esm/const.js` bundles
 * into the output.
 *
 * `@ffmpeg/ffmpeg` exports `CORE_URL` as a hard-coded unpkg URL used only when
 * the loader does not pass an explicit `coreURL`. Our loader always does, so
 * the literal is dead code at runtime — but Chrome Web Store MV3 reviewers
 * string-match full CDN URLs in built JS and Wave 5 reviewers do the same
 * sweep over the webapp bundle, so a leftover unpkg URL is enough to fail
 * review even when the runtime never fetches it.
 *
 * Originally lived inline in `packages/chrome-extension/vite.config.ts` and
 * only ran over `dist/extension/`. Extracted here so the `webapp` build emits
 * the same sanitized `dist/ui/` and the two configs can't drift apart again.
 *
 * The strip runs in `closeBundle` so it sees the final on-disk output —
 * including bundles produced by the esbuild `closeBundle` plugins that live
 * outside Rollup's module graph (the extension's preview-sw, content-script,
 * service-worker, etc.).
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Match the unpkg ffmpeg-core URL — any version, any path under the package. */
export const FFMPEG_CORE_CDN_LITERAL_RE =
  /https:\/\/unpkg\.com\/@ffmpeg\/core@[^"'`\s]*?\/ffmpeg-core\.js/g;

/**
 * Replace every unpkg ffmpeg-core URL in `code` with an empty string. The
 * literal sits in dead code (the loader overrides `coreURL`), so correctness
 * only requires that no full-path unpkg URL survives. Pure for testing.
 */
export function stripFfmpegCoreCdnLiteral(code: string): { code: string; changed: boolean } {
  FFMPEG_CORE_CDN_LITERAL_RE.lastIndex = 0;
  if (!FFMPEG_CORE_CDN_LITERAL_RE.test(code)) {
    return { code, changed: false };
  }
  FFMPEG_CORE_CDN_LITERAL_RE.lastIndex = 0;
  return { code: code.replace(FFMPEG_CORE_CDN_LITERAL_RE, ''), changed: true };
}

/** Walk every `.js` file under `dir` (recursive). */
function walkJsFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[strip-ffmpeg-core-cdn-literal] could not read ${dir}: ${(err as Error).message}`
      );
    }
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Sweep every `.js` under `outDir` and rewrite any surviving unpkg
 * ffmpeg-core URL literal. Returns the touched files (for logging/tests).
 */
export function stripFfmpegCoreCdnLiteralFromDir(outDir: string): { rewritten: string[] } {
  const rewritten: string[] = [];
  for (const js of walkJsFiles(outDir)) {
    const code = readFileSync(js, 'utf8');
    const { code: out, changed } = stripFfmpegCoreCdnLiteral(code);
    if (changed) {
      writeFileSync(js, out);
      rewritten.push(js);
    }
  }
  return { rewritten };
}

/**
 * Build-only Vite plugin; strips the unpkg ffmpeg-core URL after the output
 * is fully written. Shared between `packages/webapp/vite.config.ts` (dist/ui)
 * and `packages/chrome-extension/vite.config.ts` (dist/extension).
 */
export function stripFfmpegCoreCdnLiteralPlugin(): Plugin {
  let outDir = '';
  let root = '';
  return {
    name: 'strip-ffmpeg-core-cdn-literal',
    apply: 'build',
    enforce: 'post',
    configResolved(config: ResolvedConfig) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { rewritten } = stripFfmpegCoreCdnLiteralFromDir(outDir);
      if (rewritten.length > 0) {
        const label = relative(root, outDir) || outDir;
        console.log(
          `[strip-ffmpeg-core-cdn-literal] sanitized ${rewritten.length} file(s) in ${label}/`
        );
      }
    },
  };
}
