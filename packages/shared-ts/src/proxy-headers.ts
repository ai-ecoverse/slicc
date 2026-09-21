export function encodeForbiddenRequestHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie') {
      result['X-Proxy-Cookie'] = value;
    } else if (lower === 'origin') {
      result['X-Proxy-Origin'] = value;
    } else if (lower === 'referer') {
      result['X-Proxy-Referer'] = value;
    } else if (lower.startsWith('proxy-')) {
      result[`X-Proxy-${key}`] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function decodeForbiddenRequestHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'x-proxy-cookie') {
      result['cookie'] = value;
    } else if (lower === 'x-proxy-origin') {
      result['origin'] = value;
    } else if (lower === 'x-proxy-referer') {
      result['referer'] = value;
    } else if (lower.startsWith('x-proxy-proxy-')) {
      result[lower.replace(/^x-proxy-/, '')] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const PROXY_WWW_AUTHENTICATE_HEADER = 'X-Proxy-Www-Authenticate';

export function decodeForbiddenResponseHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'x-proxy-set-cookie') {
      result['set-cookie'] = value;
    } else if (lower === PROXY_WWW_AUTHENTICATE_HEADER.toLowerCase()) {
      result['www-authenticate'] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function headersToRecord(
  headers: Record<string, string> | Headers | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const rec: Record<string, string> = {};
    headers.forEach((v, k) => {
      rec[k] = v;
    });
    return rec;
  }
  return headers;
}

export function normalizeHeadersInit(
  headers: Headers | Record<string, string> | Array<[string, string]> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const rec: Record<string, string> = {};
    headers.forEach((v, k) => {
      rec[k] = v;
    });
    return Object.keys(rec).length === 0 ? undefined : rec;
  }
  if (Array.isArray(headers)) {
    const rec: Record<string, string> = {};
    for (const [k, v] of headers) rec[k] = v;
    return Object.keys(rec).length === 0 ? undefined : rec;
  }
  const rec = { ...(headers as Record<string, string>) };
  return Object.keys(rec).length === 0 ? undefined : rec;
}
