/**
 * Which tab does `curlwright` run in?
 *
 * `--tab` is explicit and always wins. Without it the command uses the
 * tab whose ORIGIN matches the request URL — you are calling an app's own
 * backend, and the tab logged into that app is the one holding the
 * cookies — but only when EXACTLY ONE tab matches. Two tabs on the same
 * origin may be two different accounts (the roster spans tray
 * followers), so that is an error listing the candidates, as is having
 * no match with several tabs open. Running a mutating request against
 * the wrong session is worse than not running it.
 */

import { listAllTargetsWithRemote } from '../playwright/state.js';
import type { PlaywrightHandlerCtx } from '../playwright/types.js';

type BrowserAPI = PlaywrightHandlerCtx['browser'];

export interface TabResolutionError {
  message: string;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function formatCandidates(pages: { targetId: string; url: string; title: string }[]): string {
  return pages.map((page) => `  --tab=${page.targetId}  ${page.url}`).join('\n');
}

/**
 * Resolve the target tab for a request to `url`. Returns the targetId,
 * or a message explaining exactly which `--tab` to pass.
 */
export async function resolveCurlwrightTab(
  browser: BrowserAPI,
  url: string,
  explicitTab: string | null
): Promise<{ targetId: string } | TabResolutionError> {
  if (explicitTab) return { targetId: explicitTab };

  let pages: { targetId: string; url: string; title: string }[];
  try {
    pages = await listAllTargetsWithRemote(browser);
  } catch (err) {
    return { message: `curlwright: cannot list tabs: ${err instanceof Error ? err.message : err}` };
  }
  if (pages.length === 0) {
    return { message: 'curlwright: no open tabs — open one with `playwright-cli open <url>`' };
  }

  const wanted = originOf(url);
  const sameOrigin = wanted ? pages.filter((page) => originOf(page.url) === wanted) : [];
  if (sameOrigin.length === 1) return { targetId: sameOrigin[0].targetId };
  // Two tabs on one origin are not interchangeable: `listAllTargetsWithRemote`
  // spans tray followers, so they can be different browser profiles signed in
  // as different accounts. Picking the first would run a mutating request
  // against whichever one happened to sort first.
  if (sameOrigin.length > 1) {
    return {
      message:
        `curlwright: ${sameOrigin.length} open tabs are on ${wanted} — pass --tab to pick one.\n` +
        `${formatCandidates(sameOrigin)}\n`,
    };
  }
  if (pages.length === 1) return { targetId: pages[0].targetId };

  const reason = wanted ? `no open tab is on ${wanted}` : `a relative URL needs an explicit tab`;
  return {
    message:
      `curlwright: ${reason}, and several tabs are open — pass --tab.\n` +
      `${formatCandidates(pages)}\n`,
  };
}
