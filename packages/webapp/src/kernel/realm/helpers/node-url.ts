export interface NodeUrl {
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  fileURLToPath(url: string | URL): string;
  pathToFileURL(path: string): URL;
}

function fileURLToPath(url: string | URL): string {
  const str = typeof url === 'string' ? url : url.href;
  if (!str.startsWith('file:')) throw new TypeError('fileURLToPath: not a file URL');

  const parsed = new URL(str);
  if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
    throw Object.assign(new TypeError('File URL host must be "localhost" or empty on posix'), {
      code: 'ERR_INVALID_FILE_URL_HOST',
    });
  }
  if (/%2f/i.test(parsed.pathname)) {
    throw Object.assign(new TypeError('File URL path must not include encoded / characters'), {
      code: 'ERR_INVALID_FILE_URL_PATH',
    });
  }
  return decodeURIComponent(parsed.pathname);
}

function pathToFileURL(path: string): URL {
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return new URL(`file://${encoded}`);
}

export const nodeUrl: NodeUrl = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath,
  pathToFileURL,
};
