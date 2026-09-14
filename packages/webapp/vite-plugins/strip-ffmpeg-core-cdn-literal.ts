import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export const FFMPEG_CORE_CDN_LITERAL_RE =
  /https:\/\/unpkg\.com\/@ffmpeg\/core@[^"'`\s]*?\/ffmpeg-core\.js/g;

export function stripFfmpegCoreCdnLiteral(code: string): { code: string; changed: boolean } {
  FFMPEG_CORE_CDN_LITERAL_RE.lastIndex = 0;
  if (!FFMPEG_CORE_CDN_LITERAL_RE.test(code)) {
    return { code, changed: false };
  }
  FFMPEG_CORE_CDN_LITERAL_RE.lastIndex = 0;
  return { code: code.replace(FFMPEG_CORE_CDN_LITERAL_RE, ''), changed: true };
}

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
