import { base64ToUint8 } from '@slicc/shared-ts';
import { extensionForMimeType } from '../base/mime-types.js';
import { isTextMimeType, looksLikeText, sniffMagicBytes } from './file-type.js';

export interface Base64Payload {
  bytes: Uint8Array<ArrayBuffer>;

  mime: string;

  text: boolean;

  source: 'magic' | 'declared' | 'content';

  name: string;
}

const SYNTHETIC_STEM = 'payload';

export function identifyBase64(data: string, declaredMime?: string): Base64Payload | null {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToUint8(data);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  const magic = sniffMagicBytes(bytes);
  if (magic) return payload(bytes, magic, 'magic');

  const declared = declaredMime?.split(';', 1)[0]?.trim().toLowerCase();
  if (declared && declared.length > 0 && declared !== 'application/octet-stream') {
    return payload(bytes, declared, 'declared');
  }

  if (looksLikeText(bytes)) return payload(bytes, 'text/plain', 'content');
  return null;
}

function payload(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  source: Base64Payload['source']
): Base64Payload {
  const ext = extensionForMimeType(mime);
  return {
    bytes,
    mime,
    text: isTextMimeType(mime),
    source,
    name: ext ? `${SYNTHETIC_STEM}.${ext}` : SYNTHETIC_STEM,
  };
}
