import type { IFileSystem } from 'just-bash';

export function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: '',
  };
}

export function response(
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
  statusText = ''
) {
  return {
    status,
    statusText,
    headers,
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    url: 'https://example.test',
  };
}
