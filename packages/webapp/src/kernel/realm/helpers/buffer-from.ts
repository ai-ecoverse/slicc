export function bufferFrom(
  value: ArrayBuffer | Uint8Array | number[] | string,
  encoding?: string
): Buffer {
  const B = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (!B) throw new Error('crypto.createHash: Buffer is unavailable in this environment');
  return encoding ? B.from(value as string, encoding as BufferEncoding) : B.from(value as never);
}
