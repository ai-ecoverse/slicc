/**
 * Unit tests for export-spool.ts — injectable spool interface and MemorySpool.
 *
 * TDD RED phase: all tests written before production code exists.
 * These tests prove the bounded-memory contract: chunk data passes through
 * the spool interface and does not accumulate in caller state.
 */

import { sha256 } from 'js-sha256';
import { describe, expect, it } from 'vitest';
import { MemorySpool } from '../../src/transcript/export-spool.js';

const bytes = (values: number[]): Uint8Array => Uint8Array.from(values);

// ---------------------------------------------------------------------------
// MemorySpool: basic contract
// ---------------------------------------------------------------------------

describe('MemorySpool', () => {
  it('appends chunks and finalizes to a Blob', async () => {
    const spool = new MemorySpool();
    const chunk0 = bytes([1, 2, 3]);
    const chunk1 = bytes([4, 5, 6]);

    await spool.append(chunk0, 0);
    await spool.append(chunk1, 1);

    const hasher = sha256.create();
    hasher.update(chunk0);
    hasher.update(chunk1);
    const digest = hasher.hex();

    const blob = await spool.finalize(2, 6, digest);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBe(6);

    const raw = new Uint8Array(await blob.arrayBuffer());
    expect(raw).toEqual(bytes([1, 2, 3, 4, 5, 6]));
  });

  it('cancel clears accumulated chunks', async () => {
    const spool = new MemorySpool();
    await spool.append(bytes([10, 20, 30]), 0);
    await spool.cancel();

    // After cancel, finalize should not work (spool is in cancelled state)
    await expect(spool.finalize(1, 3, 'any')).rejects.toThrow();
  });

  it('rejects on chunk count mismatch at finalize', async () => {
    const spool = new MemorySpool();
    await spool.append(bytes([1]), 0);

    // Only 1 chunk appended, finalize says 2 expected
    await expect(spool.finalize(2, 1, 'any')).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('rejects on byte length mismatch at finalize', async () => {
    const spool = new MemorySpool();
    const chunk = bytes([1, 2, 3]);
    await spool.append(chunk, 0);

    const hasher = sha256.create();
    hasher.update(chunk);
    const digest = hasher.hex();

    // Wrong byte length
    await expect(spool.finalize(1, 999, digest)).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('rejects on SHA-256 mismatch at finalize', async () => {
    const spool = new MemorySpool();
    const chunk = bytes([1, 2, 3]);
    await spool.append(chunk, 0);

    // Wrong digest
    await expect(spool.finalize(1, 3, 'bad-digest')).rejects.toMatchObject({
      code: 'transfer-corrupt',
    });
  });

  it('cancel is idempotent', async () => {
    const spool = new MemorySpool();
    await spool.append(bytes([1]), 0);
    await spool.cancel();
    await expect(spool.cancel()).resolves.toBeUndefined();
  });

  it('handles empty transfer (zero chunks)', async () => {
    const spool = new MemorySpool();
    const blob = await spool.finalize(0, 0, sha256(new Uint8Array(0)));
    expect(blob.size).toBe(0);
  });

  it('preserves exact bytes across a large multi-chunk transfer', async () => {
    const spool = new MemorySpool();
    const chunks: Uint8Array[] = [];
    const hasher = sha256.create();
    let totalBytes = 0;

    for (let i = 0; i < 10; i++) {
      const chunk = new Uint8Array(1024).fill(i);
      chunks.push(chunk);
      await spool.append(chunk, i);
      hasher.update(chunk);
      totalBytes += chunk.byteLength;
    }

    const blob = await spool.finalize(10, totalBytes, hasher.hex());
    expect(blob.size).toBe(totalBytes);

    const raw = new Uint8Array(await blob.arrayBuffer());
    let offset = 0;
    for (const chunk of chunks) {
      expect(raw.subarray(offset, offset + chunk.byteLength)).toEqual(chunk);
      offset += chunk.byteLength;
    }
  });

  it('implements ExportSpool interface (type check via duck typing)', async () => {
    const spool = new MemorySpool();
    expect(typeof spool.append).toBe('function');
    expect(typeof spool.finalize).toBe('function');
    expect(typeof spool.cancel).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ExportSpool interface: exported type
// ---------------------------------------------------------------------------

describe('ExportSpool interface', () => {
  it('can be implemented by MemorySpool', () => {
    // Type-level check via runtime duck-typing
    const spool: import('../../src/transcript/export-spool.js').ExportSpool = new MemorySpool();
    expect(spool).toBeDefined();
  });
});
