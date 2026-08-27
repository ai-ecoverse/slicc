/**
 * Cookie subcommands (via the CDP Network domain): cookie-list, cookie-get,
 * cookie-set, cookie-delete, cookie-clear.
 */

import { getCurrentPageLocation, requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

/** CDP Network.Cookie fields used by cookie-list / cookie-get output. */
interface CdpCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

interface NetworkGetCookiesResponse {
  cookies?: CdpCookie[];
}

interface NetworkSetCookieParams {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
  sameSite?: string;
  url?: string;
}

interface NetworkDeleteCookiesParams {
  name: string;
  domain?: string;
  path?: string;
  url?: string;
}

function cookiesFromCdpResponse(response: NetworkGetCookiesResponse): CdpCookie[] {
  return response.cookies ?? [];
}

function formatCookieLine(c: CdpCookie): string {
  return `${c.name}=${c.value}\tDomain=${c.domain}\tPath=${c.path}\tSecure=${c.secure}\tHttpOnly=${c.httpOnly}\tExpires=${c.expires}`;
}

function toSetCookieCdpParams(params: NetworkSetCookieParams) {
  return {
    name: params.name,
    value: params.value,
    ...(params.domain !== undefined ? { domain: params.domain } : {}),
    ...(params.path !== undefined ? { path: params.path } : {}),
    ...(params.secure !== undefined ? { secure: params.secure } : {}),
    ...(params.httpOnly !== undefined ? { httpOnly: params.httpOnly } : {}),
    ...(params.expires !== undefined ? { expires: params.expires } : {}),
    ...(params.sameSite !== undefined ? { sameSite: params.sameSite } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
  };
}

function toDeleteCookiesCdpParams(params: NetworkDeleteCookiesParams) {
  return {
    name: params.name,
    ...(params.domain !== undefined ? { domain: params.domain } : {}),
    ...(params.path !== undefined ? { path: params.path } : {}),
    ...(params.url !== undefined ? { url: params.url } : {}),
  };
}

export const cookieListHandler: PlaywrightHandler = async ({ browser, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const domain = flags['domain'];
  const path = flags['path'];
  const output = await browser.withTab(tab.targetId, async () => {
    const cdpCookies = (await browser.sendCDP('Network.getCookies')) as NetworkGetCookiesResponse;
    const cookies = cookiesFromCdpResponse(cdpCookies);
    const filtered =
      domain || path
        ? cookies.filter(
            (c) =>
              (!domain || String(c.domain ?? '').includes(domain)) &&
              (!path || String(c.path ?? '').startsWith(path))
          )
        : cookies;
    if (filtered.length === 0) {
      return 'No cookies';
    }
    const lines = filtered.map(formatCookieLine);
    return lines.join('\n');
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const cookieGetHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'cookie-get requires a cookie name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const cookieName = positional[0];
  const output = await browser.withTab(tab.targetId, async () => {
    const cdpGetCookies = (await browser.sendCDP(
      'Network.getCookies'
    )) as NetworkGetCookiesResponse;
    const cookies = cookiesFromCdpResponse(cdpGetCookies);
    const matched = cookies.filter((c) => c.name === cookieName);
    if (matched.length === 0) {
      throw new Error(`Cookie "${cookieName}" not found`);
    }
    const lines = matched.map(formatCookieLine);
    return lines.join('\n');
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const cookieSetHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'cookie-set requires <name> <value>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await browser.withTab(tab.targetId, async () => {
    const pageLocation = await getCurrentPageLocation(browser);
    const params: NetworkSetCookieParams = {
      name: positional[0],
      value: positional[1],
    };
    if (flags['domain']) params.domain = flags['domain'];
    if (flags['path']) params.path = flags['path'];
    if (flags['secure'] === 'true') params.secure = true;
    if (flags['httpOnly'] === 'true') params.httpOnly = true;
    if (flags['expires']) params.expires = parseFloat(flags['expires']);
    if (flags['sameSite']) params.sameSite = flags['sameSite'];
    if (!params.domain && !params.path) {
      params.url = pageLocation.href;
    }
    await browser.sendCDP('Network.setCookie', toSetCookieCdpParams(params));
  });
  return { stdout: `Cookie "${positional[0]}" set\n`, stderr: '', exitCode: 0 };
};

export const cookieDeleteHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'cookie-delete requires a cookie name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await browser.withTab(tab.targetId, async () => {
    const delParams: NetworkDeleteCookiesParams = { name: positional[0] };
    if (flags['domain']) delParams.domain = flags['domain'];
    if (flags['path']) delParams.path = flags['path'];
    if (!delParams.domain && !delParams.path) {
      const pageLocation = await getCurrentPageLocation(browser);
      delParams.url = pageLocation.href;
    }
    await browser.sendCDP('Network.deleteCookies', toDeleteCookiesCdpParams(delParams));
  });
  return { stdout: `Cookie "${positional[0]}" deleted\n`, stderr: '', exitCode: 0 };
};

export const cookieClearHandler: PlaywrightHandler = async ({ browser, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await browser.withTab(tab.targetId, async () => {
    await browser.sendCDP('Network.clearBrowserCookies');
  });
  return { stdout: 'All cookies cleared\n', stderr: '', exitCode: 0 };
};
