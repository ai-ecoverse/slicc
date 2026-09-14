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
