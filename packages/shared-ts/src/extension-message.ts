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
