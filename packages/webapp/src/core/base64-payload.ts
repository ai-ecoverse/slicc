/**
 * Deciding whether a base64 candidate is really a payload, and what it is.
 *
 * The verifying half of the transcript's base64 preview;
 * `core/base64-mentions.ts` is the guessing half. Nothing here is new
 * machinery — it decodes with the shared codec (`@slicc/shared-ts`) and asks
 * the existing sniffer (`core/file-type.ts`) what the bytes are, in the same
 * magic → declared → decodability order the file previewer uses. What it adds
 * is the VERDICT: a candidate whose bytes nothing recognizes is not a payload
 * as far as the transcript is concerned, and stays plain text.
 *
 * That refusal is the point. Eliding a run behind a chip hides text the user
 * wrote, so the bar is "we can show you what this is", not "this parses as
 * base64". A sha256 digest, a random id, a slice of some longer token: all of
 * them decode to bytes that are neither a known format nor readable text, and
 * all of them stay exactly as typed.
 */

import { base64ToUint8 } from '@slicc/shared-ts';
import { extensionForMimeType } from '../base/mime-types.js';
import { isTextMimeType, looksLikeText, sniffMagicBytes } from './file-type.js';

/** A decoded, recognized base64 payload. */
export interface Base64Payload {
  /** The decoded bytes. */
  bytes: Uint8Array<ArrayBuffer>;
  /** What the bytes are. Never `application/octet-stream` — see {@link identifyBase64}. */
  mime: string;
  /** Whether the payload can be shown as text. */
  text: boolean;
  /** How the type was determined. */
  source: 'magic' | 'declared' | 'content';
  /**
   * A synthetic file name for the payload, e.g. `payload.png`.
   *
   * Quick Look needs SOMETHING to put in its header and to infer a highlighting
   * language from, and a decoded blob has no name of its own. `payload` says
   * plainly that the name was invented.
   */
  name: string;
}

/** The stem of every synthetic name, so a preview never pretends to be a real file. */
const SYNTHETIC_STEM = 'payload';

/**
 * Decode `data` and identify it, or return `null` if the bytes are not
 * recognizable.
 *
 * `declaredMime` is what a `data:` URL said it was. It is trusted only AFTER
 * magic bytes, and only when it is not the do-not-know type: a `data:` URL is
 * the author's claim about their own payload, which is good evidence but not
 * proof, and `application/octet-stream` is not even a claim.
 */
export function identifyBase64(data: string, declaredMime?: string): Base64Payload | null {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToUint8(data);
  } catch {
    return null; // not base64 after all
  }
  if (bytes.length === 0) return null;

  const magic = sniffMagicBytes(bytes);
  if (magic) return payload(bytes, magic, 'magic');

  const declared = declaredMime?.split(';', 1)[0]?.trim().toLowerCase();
  if (declared && declared.length > 0 && declared !== 'application/octet-stream') {
    return payload(bytes, declared, 'declared');
  }

  // No signature and nobody said what it is. The bytes get the last word, and
  // "unreadable" is a `null` rather than an opaque chip: see the module note.
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
