import type { ComputerFrame } from '@slicc/shared-ts';
import { uint8ToBase64 } from '@slicc/shared-ts';
import { coerceComputerFrameBytes, sniffFrameMime } from '../computers/frame-bytes.js';

export function frameToDataUrl(frame: ComputerFrame): string {
  const bytes = coerceComputerFrameBytes(frame.bytes);
  const mime = sniffFrameMime(bytes) ?? frame.mime;
  return `data:${mime};base64,${uint8ToBase64(bytes)}`;
}
