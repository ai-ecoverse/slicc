import { TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';

export interface ExportSpool {
  append(chunk: Uint8Array, index: number): Promise<void>;

  finalize(chunkCount: number, byteLength: number, sha256Hex: string): Promise<Blob>;

  cancel(): Promise<void>;
}

export class MemorySpool implements ExportSpool {
  private readonly parts: Uint8Array[] = [];
  private cancelled = false;

  async append(chunk: Uint8Array, _index: number): Promise<void> {
    if (this.cancelled) throw new Error('MemorySpool: already cancelled');
    this.parts.push(chunk);
  }

  async finalize(chunkCount: number, byteLength: number, sha256Hex: string): Promise<Blob> {
    if (this.cancelled) throw new TranscriptExportError('transfer-corrupt');

    if (this.parts.length !== chunkCount) {
      throw new TranscriptExportError('transfer-corrupt');
    }

    let total = 0;
    for (const p of this.parts) total += p.byteLength;
    if (total !== byteLength) {
      throw new TranscriptExportError('transfer-corrupt');
    }

    const hasher = sha256.create();
    for (const p of this.parts) hasher.update(p);
    if (hasher.hex() !== sha256Hex) {
      throw new TranscriptExportError('transfer-corrupt');
    }

    const blob = new Blob(this.parts as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
    this.parts.length = 0;
    return blob;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.parts.length = 0;
  }
}

export class OpfsSpool implements ExportSpool {
  private readonly tempName: string;
  private writable: FileSystemWritableFileStream | null = null;
  private readonly hasher = sha256.create();
  private chunkCount = 0;
  private bytesWritten = 0;
  private cancelled = false;
  private fileHandle: FileSystemFileHandle | null = null;
  private dirHandle: FileSystemDirectoryHandle | null = null;

  private writeChain: Promise<void> = Promise.resolve();

  constructor(requestId: string) {
    this.tempName = `export-${requestId}.zip.tmp`;
  }

  private async openWritable(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    this.dirHandle = await root.getDirectoryHandle('.slicc-export-tmp', { create: true });
    this.fileHandle = await this.dirHandle.getFileHandle(this.tempName, { create: true });
    this.writable = await this.fileHandle.createWritable();
  }

  async append(chunk: Uint8Array, _index: number): Promise<void> {
    if (this.cancelled) throw new Error('OpfsSpool: already cancelled');
    if (!this.writable) await this.openWritable();

    const buf = chunk.buffer instanceof ArrayBuffer ? chunk : new Uint8Array(chunk);

    const write = this.writeChain.then(async () => {
      if (this.cancelled) throw new Error('OpfsSpool: already cancelled');
      await this.writable!.write(buf as unknown as FileSystemWriteChunkType);
      this.hasher.update(chunk);
      this.bytesWritten += chunk.byteLength;
      this.chunkCount++;
    });

    this.writeChain = write.catch(() => {});
    return write;
  }

  async finalize(chunkCount: number, byteLength: number, sha256Hex: string): Promise<Blob> {
    if (this.cancelled) throw new TranscriptExportError('transfer-corrupt');

    await this.writeChain;

    if (this.chunkCount !== chunkCount || this.bytesWritten !== byteLength) {
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }
    if (this.hasher.hex() !== sha256Hex) {
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }

    if (!this.fileHandle) {
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }

    try {
      await this.writable?.close();
      this.writable = null;
      const file = await this.fileHandle.getFile();

      let blob: Blob;
      if (typeof file.stream === 'function') {
        const response = new Response(file.stream(), {
          headers: { 'Content-Type': 'application/zip' },
        });
        blob = await response.blob();
      } else {
        blob = new Blob([await file.arrayBuffer()], { type: 'application/zip' });
      }

      await this.deleteTempFile();
      return blob;
    } catch {
      this.writable = null;
      await this.cleanup();
      throw new TranscriptExportError('transfer-corrupt');
    }
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.writable?.close();
    } catch {}
    this.writable = null;
    await this.deleteTempFile();
  }

  private async deleteTempFile(): Promise<void> {
    try {
      await this.dirHandle?.removeEntry(this.tempName);
    } catch {}
    this.fileHandle = null;
  }
}

export function makeExportSpool(requestId: string): ExportSpool {
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    return new OpfsSpool(requestId);
  }
  return new MemorySpool();
}
