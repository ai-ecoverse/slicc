export interface NodeUrl {
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  fileURLToPath(url: string | URL): string;
  pathToFileURL(path: string): URL;
}

function fileURLToPath(url: string | URL): string {
  const str = typeof url === 'string' ? url : url.href;
  if (!str.startsWith('file://')) throw new TypeError('fileURLToPath: not a file URL');
  const pathname = str.slice('file://'.length);
  return decodeURIComponent(pathname);
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
