/**
 * Pure JavaScript bzip2 compressor.
 *
 * Implements the bzip2 compression algorithm (public domain, Julian Seward 1996).
 * Pipeline: RLE1 → BWT → MTF → RLE2 (RUNA/RUNB) → Huffman → bitstream output.
 *
 * This exists because no permissively-licensed JS bzip2 compressor is available
 * on npm. Decompression uses the MIT-licensed `seek-bzip` package instead.
 */
/**
 * Compress data using bzip2 algorithm.
 * @param data - Input data to compress
 * @param blockSizeLevel - Block size level 1-9 (x 100KB), default 9
 * @param maxSize - Maximum input size in bytes (default 10MB)
 * @returns Compressed bzip2 data
 */
export declare function bzip2Compress(data: Uint8Array, blockSizeLevel?: number, maxSize?: number): Uint8Array;
