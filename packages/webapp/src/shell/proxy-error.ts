export function isProxyError(resp: Response): boolean {
  return resp.headers.get('x-proxy-error') === '1';
}

export async function readProxyErrorMessage(resp: Response): Promise<string> {
  const fallback = `Proxy error ${resp.status}`;
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return fallback;
  }
  return parseProxyErrorBody(text, fallback);
}

export function parseProxyErrorBody(text: string, fallback: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'string' && error.length > 0) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return fallback;
}
