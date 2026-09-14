import { takeSnapshot } from '../snapshot.js';
import { parsePageJson, requireTab } from '../state.js';
import type { PlaywrightHandler, TabHandle } from '../types.js';

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

export async function annotateBoxes(
  page: TabHandle,
  refToBackendNodeId: Map<string, number>,
  text: string
): Promise<string> {
  await page.send('DOM.enable');
  await page.send('Runtime.enable');

  const boxes: Record<string, number[]> = {};
  for (const [ref, backendNodeId] of refToBackendNodeId) {
    if (ref.startsWith('f')) continue;
    try {
      const resolved = await page.send('DOM.resolveNode', { backendNodeId });
      const objectId = (resolved['object'] as { objectId?: string } | undefined)?.objectId;
      if (!objectId) continue;
      const rect = await page.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
            const r = this.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
          }`,
        returnByValue: true,
      });
      const value = (rect['result'] as { value?: number[] } | undefined)?.value;
      if (value) boxes[ref] = value;
    } catch {}
  }
  return text.replace(/\[ref=([a-z0-9]+)\]/g, (token, ref: string) =>
    boxes[ref] ? `${token} [box=${boxes[ref].join(',')}]` : token
  );
}

type ScreenshotClip = { x: number; y: number; width: number; height: number; scale?: number };

export async function hiresClip(
  page: TabHandle,
  clip: ScreenshotClip | undefined,
  fullPage: boolean
): Promise<ScreenshotClip> {
  const dims = parsePageJson<{ dpr: number; w: number; h: number; sh: number }>(
    await page.evaluate(
      `JSON.stringify({ dpr: window.devicePixelRatio, w: window.innerWidth, h: window.innerHeight, sh: document.documentElement.scrollHeight })`
    ),
    '--hires viewport dimensions'
  );
  const scale = dims.dpr || 1;
  if (clip) return { ...clip, scale };
  return { x: 0, y: 0, width: dims.w, height: fullPage ? dims.sh : dims.h, scale };
}

const FIND_CONTEXT_LINES = 2;

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

export const findHandlerImpl: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
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

  const snapshotText = await onTab(tab.targetId, async (page) => {
    const { output } = await takeSnapshot(page, state, tab.targetId, {});
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
  const regions: Array<{ start: number; end: number }> = [];
  for (const index of shown) {
    const start = Math.max(0, index - FIND_CONTEXT_LINES);
    const end = Math.min(lines.length, index + FIND_CONTEXT_LINES + 1);
    const last = regions[regions.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else regions.push({ start, end });
  }
  const blocks = regions.map((r) => lines.slice(r.start, r.end).join('\n'));
  const header =
    matchIndexes.length > FIND_MAX_MATCHES
      ? `Showing first ${FIND_MAX_MATCHES} of ${matchIndexes.length} matching lines (narrow the query for the rest):`
      : `${matchIndexes.length} matching line(s) in ${regions.length} region(s):`;
  return {
    stdout: `${header}\n\n${blocks.join('\n---\n')}\n`,
    stderr: '',
    exitCode: 0,
  };
};
