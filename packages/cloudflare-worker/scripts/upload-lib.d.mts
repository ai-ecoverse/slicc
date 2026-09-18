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

export interface StatFile {
  size: number;
}

export declare function totalFileBytes(
  files: string[],
  dir: string,
  stat?: (path: string) => Promise<StatFile>
): Promise<number>;

export interface Exec {
  (argv: string[]): Promise<any>;
}

export interface RunBulkUploadsOptions {
  bucket: string;
  dir: string;
  exec: Exec;
  concurrency?: number;
  retries?: number;
  chunkSize?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
}

export interface BulkUploadResult {
  groups: number;
  chunks: number;
  invocations: number;
  retries: number;
}

export declare function runBulkUploads(
  files: string[],
  opts: RunBulkUploadsOptions
): Promise<BulkUploadResult>;

export declare const MANIFEST_CHUNK_SIZE: number;

export declare const RETRY_BASE_DELAY_MS: number;

export declare const RETRY_MAX_DELAY_MS: number;

export declare function retryConcurrency(concurrency: number, attempt: number): number;

export declare function chunkEntries<T>(entries: T[], size?: number): T[][];

export declare function retryDelayMs(attempt: number, random?: () => number): number;
