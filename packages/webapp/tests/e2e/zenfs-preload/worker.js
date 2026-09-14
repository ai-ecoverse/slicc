import { resolveMountConfig } from '@zenfs/core';
import { WebAccess, WebAccessFS } from '@zenfs/dom';

self.onmessage = async ({ data: seed }) => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle('zenfs-static-preload', { create: true });
  if (seed) {
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < 30000) {
          const i = next++;
          const dir = await handle.getDirectoryHandle(`d${Math.floor(i / 128)}`, { create: true });
          const file = await dir.getFileHandle(`f${i}`, { create: true });
          const writer = await file.createWritable();
          await writer.write('A');
          await writer.close();
        }
      })
    );
    postMessage('seeded');
    return;
  }
  const read = WebAccessFS.prototype.read;
  let active = 0,
    peak = 0;
  WebAccessFS.prototype.read = async function (...args) {
    peak = Math.max(peak, ++active);
    try {
      return await read.apply(this, args);
    } finally {
      active--;
    }
  };
  try {
    await resolveMountConfig({ backend: WebAccess, handle });
    postMessage({ ok: true, peak, active });
  } catch (error) {
    postMessage({ ok: false, name: error.name, message: error.message, peak, active });
  }
};
