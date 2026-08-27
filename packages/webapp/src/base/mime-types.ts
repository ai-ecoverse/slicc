const MIME_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  apng: 'image/apng',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  xml: 'application/xml',
  wasm: 'application/wasm',
};

/**
 * Reverse index of {@link MIME_TYPES}, built once on first use.
 *
 * FIRST registration wins, which is why the table's order matters: `jpg`
 * precedes `jpeg` and `js` precedes `mjs`, so `image/jpeg` names itself
 * `.jpg` rather than `.jpeg`. Derived from the table rather than written out
 * a second time — a hand-kept reverse map is a table that silently drifts.
 */
let extensionByMime: Map<string, string> | null = null;

/**
 * A conventional file extension for `mime`, or `null` when nothing in the
 * table claims it.
 *
 * For naming a payload that HAS no name — the transcript's decoded base64
 * previews, which need a filename only so Quick Look has something to show in
 * its header and something for the highlighter to infer a language from. Never
 * for deciding what a file IS; that is {@link getMimeType} (serving) or
 * `core/file-type.ts` (reading).
 */
export function extensionForMimeType(mime: string): string | null {
  if (!extensionByMime) {
    extensionByMime = new Map();
    for (const [ext, type] of Object.entries(MIME_TYPES)) {
      if (!extensionByMime.has(type)) extensionByMime.set(type, ext);
    }
  }
  const base = mime.split(';', 1)[0]?.trim().toLowerCase() ?? mime;
  return extensionByMime.get(base) ?? null;
}

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
