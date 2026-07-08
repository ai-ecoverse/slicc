/**
 * Type declarations for upload-lib.mjs
 */

export declare function assertAllHashed(names: string[]): void;

export declare function buildPutArgs(bucket: string, file: string): string[];

export interface Exec {
  (argv: string[]): Promise<any>;
}

export interface RunUploadsOptions {
  bucket: string;
  dir: string;
  exec: Exec;
  concurrency?: number;
  retries?: number;
}

export declare function runUploads(files: string[], opts: RunUploadsOptions): Promise<void>;
