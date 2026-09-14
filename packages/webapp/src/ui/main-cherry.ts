import { createLogger } from '../base/logger.js';
import { CherryHostTransport } from '../cdp/cherry-host-transport.js';
import { BrowserAPI } from '../cdp/index.js';

const log = createLogger('cherry-boot');

export interface CherryBootResult {
  transport: CherryHostTransport;

  browser: BrowserAPI;

  joinUrl: string;
}

function resolveParentOrigin(): string {
  const ancestors = location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    const first = ancestors[0];

    if (first && first !== 'null') return first;
  }
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {}
  }
  return location.origin;
}

export async function setupCherryFollower(): Promise<CherryBootResult> {
  const parentOrigin = resolveParentOrigin();
  const allowOrigins = [parentOrigin];
  const targetOrigin = parentOrigin;

  const transport = new CherryHostTransport({
    counterpart: window.parent,
    allowOrigins,
    targetOrigin,
  });
  await transport.connect();
  log.info('Cherry transport connected');

  const joinUrl = transport.joinUrl;
  if (!joinUrl) {
    throw new Error('cherry boot: no joinUrl from handshake');
  }

  const browser = new BrowserAPI(transport);
  return { transport, browser, joinUrl };
}
