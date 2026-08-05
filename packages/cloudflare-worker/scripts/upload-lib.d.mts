/**
 * Type declarations for upload-lib.mjs
 */

export declare function assertAllHashed(names: string[]): void;

export declare function buildPutArgs(bucket: string, file: string, dir?: string): string[];

export interface Exec {
  (argv: string[]): Promise<any>;
}

export interface RunUploadsOptions {
  bucket: string;
  dir: string;
  exec: Exec;
  concurrency?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export declare function runUploads(files: string[], opts: RunUploadsOptions): Promise<void>;

export declare const RETRY_BASE_DELAY_MS: number;

export declare function retryDelayMs(attempt: number, random?: () => number): number;
