import { getMimeType, isAudioMimeType, isVideoMimeType } from './mime-types.js';
import { toPreviewUrl } from './preview-url.js';

export type MessageMedia =
  | { kind: 'image'; src: string }
  | { kind: 'video'; src: string; mimeType: string }
  | { kind: 'audio'; src: string; mimeType: string };

const DANGEROUS_SCHEME_RE = /^(?:javascript|vbscript|file):/i;

function isDipReference(href: string): boolean {
  return stripUrlSuffix(href).toLowerCase().endsWith('.shtml');
}

export function stripUrlSuffix(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

export function resolveMessageMedia(href: string): MessageMedia | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (DANGEROUS_SCHEME_RE.test(trimmed)) return null;
  if (isDipReference(trimmed)) return null;

  const isVfsPath = trimmed.startsWith('/') && !trimmed.startsWith('//');
  const src = isVfsPath ? toPreviewUrl(trimmed) : trimmed;

  const mimeType = trimmed.startsWith('data:')
    ? (trimmed.slice('data:'.length).split(/[;,]/, 1)[0] ?? '')
    : getMimeType(stripUrlSuffix(trimmed));

  if (isVideoMimeType(mimeType)) return { kind: 'video', src, mimeType };

  if (isAudioMimeType(mimeType)) return { kind: 'audio', src, mimeType };

  return { kind: 'image', src };
}
