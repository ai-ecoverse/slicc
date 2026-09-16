/** Type declarations for upload-lib.mjs. */

export declare function assertAllHashed(names: string[]): void;

export interface BulkManifestEntry {
  key: string;
  file: string;
}

export interface BulkManifestGroup {
  contentType: string;
  entries: BulkManifestEntry[];
}

export declare function buildManifestGroups(files: string[], dir?: string): BulkManifestGroup[];

export declare function buildBulkPutArgs(
  bucket: string,
  manifestPath: string,
  contentType: string,
  concurrency: number
): string[];

export interface Exec {
  (argv: string[]): Promise<any>;
}

export interface RunBulkUploadsOptions {
  bucket: string;
  dir: string;
  exec: Exec;
  concurrency?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BulkUploadResult {
  groups: number;
  invocations: number;
  retries: number;
}

export declare function runBulkUploads(
  files: string[],
  opts: RunBulkUploadsOptions
): Promise<BulkUploadResult>;

export declare const RETRY_BASE_DELAY_MS: number;

export declare function retryDelayMs(attempt: number, random?: () => number): number;
