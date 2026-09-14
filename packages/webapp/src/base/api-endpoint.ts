import { isChromeExtensionRealm } from '@slicc/shared-ts';

let localApiBaseUrl: string | null = null;

let bridgeToken: string | null = null;

export function setLocalApiBaseUrl(baseUrl: string | null): void {
  if (baseUrl === null || baseUrl === '') {
    localApiBaseUrl = null;
    return;
  }
  localApiBaseUrl = baseUrl.replace(/\/+$/, '');
}

export function getLocalApiBaseUrl(): string | null {
  return localApiBaseUrl;
}

export function setBridgeToken(token: string | null): void {
  bridgeToken = token === null || token === '' ? null : token;
}

export function getBridgeToken(): string | null {
  return bridgeToken;
}

let extensionDelegateId: string | null = null;

export function setExtensionDelegateId(id: string | null): void {
  extensionDelegateId = id === null || id === '' ? null : id;
}

export function getExtensionDelegateId(): string | null {
  return extensionDelegateId;
}

let chromeExtensionRealm: boolean | null = null;

export function setChromeExtensionRealm(value: boolean | null): void {
  chromeExtensionRealm = value;
}

export function getChromeExtensionRealm(): boolean {
  if (chromeExtensionRealm === null) {
    chromeExtensionRealm = isChromeExtensionRealm();
  }
  return chromeExtensionRealm;
}

export function resolveApiUrl(path: string): string {
  return localApiBaseUrl ? `${localApiBaseUrl}${path}` : path;
}

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (bridgeToken && localApiBaseUrl) {
    headers['X-Bridge-Token'] = bridgeToken;
  }
  if (extra) {
    for (const k of Object.keys(extra)) {
      headers[k] = extra[k];
    }
  }
  return headers;
}
