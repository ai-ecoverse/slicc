/**
 * Runtime type guard for the page ↔ extension-SW envelope
 * (`{ source, payload }`).
 *
 * The full `ExtensionMessage` union lives in webapp `kernel/messages.ts`
 * (kernel-internal, 11+ webapp callers). This guard is the runtime check
 * both packages share so chrome-extension tests never value-import
 * `packages/webapp/src` (#3047).
 */
export function isExtensionMessage(msg: unknown): msg is {
  source: string;
  payload: unknown;
} {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'source' in msg &&
    'payload' in msg &&
    typeof (msg as { source: unknown }).source === 'string'
  );
}
