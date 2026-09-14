import type { VirtualFS } from '../../../fs/index.js';

export async function readVfsFileBytes(fs: VirtualFS, path: string): Promise<Uint8Array> {
  const content = await fs.readFile(path, { encoding: 'binary' });
  if (content instanceof Uint8Array) return content;
  if (typeof content !== 'string') {
    throw new Error(`cannot represent '${path}' faithfully: unexpected file content type`);
  }
  if (content.includes('\uFFFD')) {
    throw new Error(
      `cannot represent '${path}' faithfully: file was read as text (contains U+FFFD). ` +
        'Binary files must be read as bytes, not UTF-8.'
    );
  }
  return new TextEncoder().encode(content);
}
