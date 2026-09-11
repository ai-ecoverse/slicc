export const PREVIEW_PREFIX: 'previews/';
export const DAY_SECONDS: number;
export const MAX_LIVE_OBJECT_DAYS: number;
export const MAX_EXPIRATION_DAYS: number;

export interface LifecycleVerificationOptions {
  env?: {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
  };
  fetchImpl?: typeof fetch;
}

/** Validates untrusted Cloudflare lifecycle API results, throwing on unsafe rules. */
export function verifyRules(result: unknown): void;
export function verifyPreviewLifecycle(
  bucket: string,
  options?: LifecycleVerificationOptions
): Promise<void>;
export function main(args?: string[], options?: LifecycleVerificationOptions): Promise<void>;
