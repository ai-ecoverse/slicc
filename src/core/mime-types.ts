const MIME_TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript', mjs: 'application/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  apng: 'image/apng', bmp: 'image/bmp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  m4v: 'video/x-m4v', ogv: 'video/ogg',
  pdf: 'application/pdf', txt: 'text/plain', xml: 'application/xml',
  wasm: 'application/wasm',
};

/** Map a file path (or extension) to its MIME type. */
export function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

export function isTerminalPreviewableMimeType(mimeType: string): boolean {
  return isImageMimeType(mimeType) || isVideoMimeType(mimeType);
}

export function isTerminalPreviewableMediaPath(filePath: string): boolean {
  return isTerminalPreviewableMimeType(getMimeType(filePath));
}
