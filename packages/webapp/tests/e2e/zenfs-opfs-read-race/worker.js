import { resolveMountConfig } from '@zenfs/core';
import { WebAccess, WebAccessFS } from '@zenfs/dom';

// One real OPFS file. The hook only controls scheduling; Chromium itself
// throws NotReadableError when ZenFS reads the invalidated File snapshot.
self.onmessage = async ({ data: { always = false } }) => {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('zenfs-one-file-race', { create: true });
  const handle = await directory.getFileHandle('race.txt', { create: true });
  const write = async (text) => {
    const stream = await handle.createWritable();
    await stream.write(text);
    await stream.close();
  };
  await write('before');
  const nativeGetFile = FileSystemFileHandle.prototype.getFile;
  const nativeRead = WebAccessFS.prototype.read;
  let reading = false;
  let rewrites = 0;
  WebAccessFS.prototype.read = async function (...args) {
    reading = true;
    try {
      return await nativeRead.apply(this, args);
    } finally {
      reading = false;
    }
  };
  FileSystemFileHandle.prototype.getFile = async function () {
    const snapshot = await nativeGetFile.call(this);
    if (reading && this.name === 'race.txt' && (always || rewrites === 0)) {
      rewrites++;
      await write(rewrites % 2 ? 'after!' : 'before');
    }
    return snapshot;
  };
  try {
    const fs = await resolveMountConfig({ backend: WebAccess, handle: directory });
    const data = new Uint8Array(6);
    fs.readSync('/race.txt', data, 0, 6);
    postMessage({ ok: true, rewrites, contents: new TextDecoder().decode(data) });
  } catch (error) {
    postMessage({ ok: false, rewrites, error: error.name, message: error.message });
  } finally {
    FileSystemFileHandle.prototype.getFile = nativeGetFile;
    WebAccessFS.prototype.read = nativeRead;
  }
};
