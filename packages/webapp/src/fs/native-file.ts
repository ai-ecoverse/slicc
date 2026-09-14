export async function fileFromDirectoryHandle(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<File | null> {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (name === undefined) return null;
  try {
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch {
    return null;
  }
}
