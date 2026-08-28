/**
 * Official-CLI alignment features for snapshot/find/screenshot: --depth,
 * --boxes, the find command, and --hires.
 *
 * LOADED LAZILY from `handlers/snapshot.js`: none of this code is needed
 * until one of the flags (or `find`) is actually used, and the handlers
 * dispatch table sits in the kernel worker's boot-critical graph, which
 * `first-load-budget.json` holds to a per-change ratchet.
 */

import { takeSnapshot } from '../snapshot.js';
import { parsePageJson, requireTab } from '../state.js';
import type { PlaywrightHandler, PlaywrightHandlerCtx } from '../types.js';

type BrowserAPI = PlaywrightHandlerCtx['browser'];

/**
 * Keep only snapshot node lines above `depth` nesting levels (2-space indent
 * per level; headers and blank lines always pass), appending an elision note
 * so a truncated tree is never mistaken for the whole page.
 */
export function limitSnapshotDepth(text: string, depth: number): string {
  let elided = 0;
  const kept = text.split('\n').filter((line) => {
    const node = /^( *)- /.exec(line);
    if (!node) return true;
    if (node[1].length / 2 < depth) return true;
    elided++;
    return false;
  });
  if (elided > 0) {
    kept.push(
      `(${elided} node(s) below depth ${depth} elided — re-run without --depth for the full tree)`
    );
  }
  return kept.join('\n');
}

/**
 * Append `[box=x,y,w,h]` (viewport-relative CSS pixels, per
 * getBoundingClientRect) to every main-frame ref line, resolving all refs in
 * a single page evaluation. Frame-prefixed refs are skipped — their rects
 * live in another frame's coordinate space.
 */
export async function annotateBoxes(
  browser: BrowserAPI,
  refToSelector: Map<string, string>,
  text: string
): Promise<string> {
  const selectors: Record<string, string> = {};
  for (const [ref, selector] of refToSelector) {
    if (!ref.startsWith('f')) selectors[ref] = selector.split(',')[0].trim();
  }
  const json = await browser.evaluate(
    `(function() {
      const sels = ${JSON.stringify(selectors)};
      const out = {};
      for (const ref of Object.keys(sels)) {
        try {
          const el = document.querySelector(sels[ref]);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          out[ref] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        } catch {}
      }
      return JSON.stringify(out);
    })()`
  );
  const boxes = parsePageJson<Record<string, number[]>>(json, 'snapshot --boxes rect batch');
  return text.replace(/\[ref=([a-z0-9]+)\]/g, (token, ref: string) =>
    boxes[ref] ? `${token} [box=${boxes[ref].join(',')}]` : token
  );
}

type ScreenshotClip = { x: number; y: number; width: number; height: number; scale?: number };

/**
 * --hires: capture in device pixels by scaling an explicit clip by the
 * device pixel ratio (CDP's clip.scale), instead of the CSS-pixel default.
 */
export async function hiresClip(
  browser: BrowserAPI,
  clip: ScreenshotClip | undefined,
  fullPage: boolean
): Promise<ScreenshotClip> {
  const dims = parsePageJson<{ dpr: number; w: number; h: number; sh: number }>(
    await browser.evaluate(
      `JSON.stringify({ dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight, sh: document.documentElement.scrollHeight })`
    ),
    '--hires viewport dimensions'
  );
  const scale = dims.dpr || 1;
  if (clip) return { ...clip, scale };
  return { x: 0, y: 0, width: dims.w, height: fullPage ? dims.sh : dims.h, scale };
}

/** Context lines shown around each find match. */
const FIND_CONTEXT_LINES = 2;
/** Cap on reported find matches, so a generic query cannot flood stdout. */
const FIND_MAX_MATCHES = 20;

function findMatcher(
  text: string,
  regexStr: string | undefined
): ((line: string) => boolean) | { error: string } {
  if (regexStr) {
    try {
      const re = new RegExp(regexStr, 'i');
      return (line) => re.test(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `find: invalid --regex: ${msg}\n` };
    }
  }
  const needle = text.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

export const findHandlerImpl: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const text = positional.join(' ');
  const regexStr = flags['regex'];
  if ((text && regexStr) || (!text && !regexStr)) {
    return {
      stdout: '',
      stderr: 'find: provide either a text argument or --regex, not both\n',
      exitCode: 1,
    };
  }
  const matches = findMatcher(text, regexStr);
  if (typeof matches !== 'function') {
    return { stdout: '', stderr: matches.error, exitCode: 1 };
  }

  const snapshotText = await browser.withTab(tab.targetId, async () => {
    const { output } = await takeSnapshot(browser, state, tab.targetId, {});
    return output;
  });
  const lines = snapshotText.split('\n');
  const matchIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matches(lines[i])) matchIndexes.push(i);
  }
  if (matchIndexes.length === 0) {
    return { stdout: 'No matches in the page snapshot.\n', stderr: '', exitCode: 0 };
  }

  const shown = matchIndexes.slice(0, FIND_MAX_MATCHES);
  const blocks = shown.map((index) => {
    const start = Math.max(0, index - FIND_CONTEXT_LINES);
    const end = Math.min(lines.length, index + FIND_CONTEXT_LINES + 1);
    return lines.slice(start, end).join('\n');
  });
  const header =
    matchIndexes.length > FIND_MAX_MATCHES
      ? `Showing first ${FIND_MAX_MATCHES} of ${matchIndexes.length} matching lines (narrow the query for the rest):`
      : `${matchIndexes.length} matching line(s):`;
  return {
    stdout: `${header}\n\n${blocks.join('\n---\n')}\n`,
    stderr: '',
    exitCode: 0,
  };
};
