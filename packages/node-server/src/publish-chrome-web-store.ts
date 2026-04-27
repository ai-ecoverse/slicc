import { createSign } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_RELEASE_MANIFEST_PATH = resolve(
  PROJECT_ROOT,
  'artifacts',
  'release',
  'release-artifacts.json'
);
const CHROME_WEB_STORE_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_UPLOAD_POLL_ATTEMPTS = 30;
const SUCCESSFUL_PUBLISH_STATES = new Set([
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
]);

interface ReleaseManifest {
  version: string;
  extensionArchive: string;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
  [key: string]: unknown;
}

export interface ChromeWebStoreConfig {
  publisherId: string;
  itemId: string;
  publishType?: 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH';
  deployPercentage?: number;
  dryRun?: boolean;
  forceCancelPendingReview?: boolean;
  skipReview?: boolean;
  serviceAccount: ServiceAccountCredentials;
}

interface TokenResponse {
  access_token?: string;
}

interface UploadResponse {
  name: string;
  itemId: string;
  crxVersion?: string;
  uploadState: string;
}

interface FetchStatusResponse {
  name: string;
  itemId: string;
  publishedItemRevisionStatus?: ItemRevisionStatus;
  submittedItemRevisionStatus?: ItemRevisionStatus;
  lastAsyncUploadState?: string;
  takenDown?: boolean;
  warned?: boolean;
}

interface ItemRevisionStatus {
  state?: string;
}

interface PublishResponse {
  name: string;
  itemId: string;
  state: string;
}

export interface ChromeWebStorePublishResult {
  version: string;
  itemId: string;
  uploadState: string;
  publishState: string;
}

export interface PublishChromeWebStoreOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: Pick<Console, 'log' | 'warn'>;
  manifestPath?: string;
  projectRoot?: string;
  nowSeconds?: () => number;
  pollIntervalMs?: number;
  maxUploadPollAttempts?: number;
  waitMs?: (ms: number) => Promise<void>;
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseOptionalBoolean(value: string | undefined, envName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${envName} must be one of true, false, 1, or 0.`);
}

function parseOptionalPercentage(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error('CHROME_WEB_STORE_DEPLOY_PERCENTAGE must be an integer between 0 and 100.');
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('CHROME_WEB_STORE_DEPLOY_PERCENTAGE must be an integer between 0 and 100.');
  }
  return parsed;
}

function parseOptionalPublishType(
  value: string | undefined
): ChromeWebStoreConfig['publishType'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'DEFAULT_PUBLISH' || value === 'STAGED_PUBLISH') return value;
  throw new Error('CHROME_WEB_STORE_PUBLISH_TYPE must be DEFAULT_PUBLISH or STAGED_PUBLISH.');
}

export function parseServiceAccountCredentials(
  jsonValue: string | undefined,
  base64Value: string | undefined
): ServiceAccountCredentials | undefined {
  const raw =
    jsonValue ??
    (base64Value ? Buffer.from(base64Value, 'base64').toString('utf8').trim() : undefined);

  if (!raw) return undefined;

  const credentials = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
  if (typeof credentials.client_email !== 'string' || !credentials.client_email.trim()) {
    throw new Error(
      'Chrome Web Store service account credentials must include a non-empty client_email.'
    );
  }
  if (typeof credentials.private_key !== 'string' || !credentials.private_key.trim()) {
    throw new Error(
      'Chrome Web Store service account credentials must include a non-empty private_key.'
    );
  }

  return {
    ...credentials,
    client_email: credentials.client_email,
    private_key: credentials.private_key,
    token_uri:
      typeof credentials.token_uri === 'string' && credentials.token_uri.trim()
        ? credentials.token_uri
        : DEFAULT_TOKEN_URI,
  };
}

export function readChromeWebStoreConfig(
  env: NodeJS.ProcessEnv = process.env
): ChromeWebStoreConfig | null {
  const publisherId = getEnvValue(env, 'CHROME_WEB_STORE_PUBLISHER_ID');
  const itemId = getEnvValue(env, 'CHROME_WEB_STORE_ITEM_ID');
  const jsonCredentials = getEnvValue(env, 'CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON');
  const base64Credentials = getEnvValue(env, 'CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON_BASE64');
  const publishType = getEnvValue(env, 'CHROME_WEB_STORE_PUBLISH_TYPE');
  const deployPercentage = getEnvValue(env, 'CHROME_WEB_STORE_DEPLOY_PERCENTAGE');
  const dryRun = getEnvValue(env, 'CHROME_WEB_STORE_DRY_RUN');
  const forceCancelPendingReview = getEnvValue(env, 'CHROME_WEB_STORE_FORCE_CANCEL_PENDING');
  const skipReview = getEnvValue(env, 'CHROME_WEB_STORE_SKIP_REVIEW');

  const hasAnyChromeWebStoreSetting = [
    publisherId,
    itemId,
    jsonCredentials,
    base64Credentials,
    publishType,
    deployPercentage,
    dryRun,
    forceCancelPendingReview,
    skipReview,
  ].some(Boolean);
  if (!hasAnyChromeWebStoreSetting) return null;

  const missing: string[] = [];
  if (!publisherId) missing.push('CHROME_WEB_STORE_PUBLISHER_ID');
  if (!itemId) missing.push('CHROME_WEB_STORE_ITEM_ID');
  if (!jsonCredentials && !base64Credentials) {
    missing.push(
      'CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON or CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON_BASE64'
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Chrome Web Store publishing is partially configured. Missing: ${missing.join(', ')}.`
    );
  }

  return {
    publisherId: publisherId!,
    itemId: itemId!,
    publishType: parseOptionalPublishType(publishType),
    deployPercentage: parseOptionalPercentage(deployPercentage),
    dryRun: parseOptionalBoolean(dryRun, 'CHROME_WEB_STORE_DRY_RUN'),
    forceCancelPendingReview: parseOptionalBoolean(
      forceCancelPendingReview,
      'CHROME_WEB_STORE_FORCE_CANCEL_PENDING'
    ),
    skipReview: parseOptionalBoolean(skipReview, 'CHROME_WEB_STORE_SKIP_REVIEW'),
    serviceAccount: parseServiceAccountCredentials(jsonCredentials, base64Credentials)!,
  };
}

export function createServiceAccountAssertion(
  serviceAccount: ServiceAccountCredentials,
  nowSeconds: number
): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: CHROME_WEB_STORE_SCOPE,
    aud: serviceAccount.token_uri ?? DEFAULT_TOKEN_URI,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsignedToken = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key).toString('base64url');
  return `${unsignedToken}.${signature}`;
}

function readReleaseManifest(manifestPath: string): ReleaseManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Release manifest was not found at ${manifestPath}. Run npm run package:release first.`
    );
  }

  return JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
}

function resolveArtifactPath(projectRoot: string, projectRelativePath: string): string {
  return resolve(projectRoot, projectRelativePath);
}

function toProjectRelative(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).split('\\').join('/');
}

function createPublisherItemName(config: ChromeWebStoreConfig): string {
  return `publishers/${config.publisherId}/items/${config.itemId}`;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function expectJsonResponse<T>(response: Response, context: string): Promise<T> {
  const data = await parseJsonResponse<unknown>(response);
  if (!response.ok) {
    const serialized = data ? ` ${JSON.stringify(data)}` : '';
    throw new Error(
      `${context} failed with ${response.status} ${response.statusText}.${serialized}`
    );
  }
  return data as T;
}

async function exchangeServiceAccountToken(
  serviceAccount: ServiceAccountCredentials,
  fetchImpl: typeof fetch,
  nowSeconds: () => number
): Promise<string> {
  const assertion = createServiceAccountAssertion(serviceAccount, nowSeconds());
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetchImpl(serviceAccount.token_uri ?? DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const tokenResponse = await expectJsonResponse<TokenResponse>(
    response,
    'Chrome Web Store OAuth token exchange'
  );

  if (!tokenResponse.access_token) {
    throw new Error('Chrome Web Store OAuth token exchange did not return an access_token.');
  }

  return tokenResponse.access_token;
}

async function uploadExtensionArchive(
  config: ChromeWebStoreConfig,
  accessToken: string,
  archiveBytes: Uint8Array,
  fetchImpl: typeof fetch
): Promise<UploadResponse> {
  const itemName = createPublisherItemName(config);
  const response = await fetchImpl(
    `https://chromewebstore.googleapis.com/upload/v2/${itemName}:upload`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/zip',
      },
      body: archiveBytes,
    }
  );

  return expectJsonResponse<UploadResponse>(response, 'Chrome Web Store upload');
}

async function fetchUploadStatus(
  config: ChromeWebStoreConfig,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<FetchStatusResponse> {
  const itemName = createPublisherItemName(config);
  const response = await fetchImpl(
    `https://chromewebstore.googleapis.com/v2/${itemName}:fetchStatus`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return expectJsonResponse<FetchStatusResponse>(response, 'Chrome Web Store upload status');
}

async function cancelPendingSubmission(
  config: ChromeWebStoreConfig,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const itemName = createPublisherItemName(config);
  const response = await fetchImpl(
    `https://chromewebstore.googleapis.com/v2/${itemName}:cancelSubmission`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Chrome Web Store cancel submission failed with ${response.status} ${response.statusText}.${text ? ` ${text}` : ''}`
    );
  }
}

async function waitForPendingReviewCancellation(
  config: ChromeWebStoreConfig,
  accessToken: string,
  fetchImpl: typeof fetch,
  waitMs: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<FetchStatusResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchUploadStatus(config, accessToken, fetchImpl);
    if (status.submittedItemRevisionStatus?.state !== 'PENDING_REVIEW') {
      return status;
    }

    if (attempt === maxAttempts) {
      throw new Error(
        `Chrome Web Store pending review cancellation did not complete after ${maxAttempts} status checks.`
      );
    }

    await waitMs(pollIntervalMs);
  }

  throw new Error('Chrome Web Store pending review cancellation polling failed unexpectedly.');
}

export async function waitForUploadCompletion(
  config: ChromeWebStoreConfig,
  accessToken: string,
  fetchImpl: typeof fetch,
  waitMs: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<FetchStatusResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchUploadStatus(config, accessToken, fetchImpl);
    const uploadState = status.lastAsyncUploadState;

    if (uploadState === 'SUCCEEDED') return status;
    if (uploadState === 'FAILED' || uploadState === 'NOT_FOUND') {
      throw new Error(`Chrome Web Store async upload finished in state ${uploadState}.`);
    }

    if (uploadState !== undefined && uploadState !== 'IN_PROGRESS') {
      throw new Error(`Chrome Web Store async upload returned unknown state ${uploadState}.`);
    }

    if (attempt === maxAttempts) {
      throw new Error(
        `Chrome Web Store async upload did not complete after ${maxAttempts} status checks.`
      );
    }

    await waitMs(pollIntervalMs);
  }

  throw new Error('Chrome Web Store async upload polling failed unexpectedly.');
}

async function ensureSubmissionCanProceed(
  config: ChromeWebStoreConfig,
  accessToken: string,
  fetchImpl: typeof fetch,
  log: Pick<Console, 'log' | 'warn'>,
  waitMs: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<{ skipped: boolean; status: FetchStatusResponse }> {
  const status = await fetchUploadStatus(config, accessToken, fetchImpl);
  if (status.submittedItemRevisionStatus?.state !== 'PENDING_REVIEW') {
    return { skipped: false, status };
  }

  if (config.dryRun) {
    const outcome = config.forceCancelPendingReview
      ? 'would cancel the pending review and resubmit'
      : 'would skip Chrome publish';
    log.warn(
      `Dry run: Chrome Web Store item ${config.itemId} already has a revision pending review, so the release ${outcome}.`
    );
    return { skipped: true, status };
  }

  if (!config.forceCancelPendingReview) {
    log.warn(
      `Skipping Chrome Web Store publish for item ${config.itemId} because a revision is already pending review. Set CHROME_WEB_STORE_FORCE_CANCEL_PENDING=true to cancel the pending review and resubmit automatically.`
    );
    return { skipped: true, status };
  }

  log.warn(
    `Cancelling the pending Chrome Web Store review for item ${config.itemId} before uploading a new revision.`
  );
  await cancelPendingSubmission(config, accessToken, fetchImpl);
  const updatedStatus = await waitForPendingReviewCancellation(
    config,
    accessToken,
    fetchImpl,
    waitMs,
    pollIntervalMs,
    maxAttempts
  );
  return { skipped: false, status: updatedStatus };
}

function logChromeWebStoreItemWarnings(
  config: ChromeWebStoreConfig,
  status: FetchStatusResponse,
  log: Pick<Console, 'warn'>
): void {
  if (status.warned) {
    log.warn(
      `Chrome Web Store item ${config.itemId} is currently warned in the developer dashboard.`
    );
  }
  if (status.takenDown) {
    log.warn(
      `Chrome Web Store item ${config.itemId} is currently taken down in the developer dashboard.`
    );
  }
}

async function publishItem(
  config: ChromeWebStoreConfig,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<PublishResponse> {
  const itemName = createPublisherItemName(config);
  const deployInfos =
    config.deployPercentage === undefined
      ? undefined
      : [
          {
            deployPercentage: config.deployPercentage,
          },
        ];
  const body = {
    ...(config.publishType ? { publishType: config.publishType } : {}),
    ...(deployInfos ? { deployInfos } : {}),
    ...(config.skipReview === undefined ? {} : { skipReview: config.skipReview }),
  };
  const response = await fetchImpl(`https://chromewebstore.googleapis.com/v2/${itemName}:publish`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return expectJsonResponse<PublishResponse>(response, 'Chrome Web Store publish');
}

export async function publishChromeWebStoreRelease(
  options: PublishChromeWebStoreOptions = {}
): Promise<ChromeWebStorePublishResult | null> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const manifestPath = options.manifestPath ?? DEFAULT_RELEASE_MANIFEST_PATH;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const waitMs =
    options.waitMs ?? ((ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxUploadPollAttempts = options.maxUploadPollAttempts ?? DEFAULT_MAX_UPLOAD_POLL_ATTEMPTS;

  const config = readChromeWebStoreConfig(env);
  if (!config) {
    log.log('Skipping Chrome Web Store publish because CHROME_WEB_STORE_* env vars are not set.');
    return null;
  }

  const releaseManifest = readReleaseManifest(manifestPath);
  const archivePath = resolveArtifactPath(projectRoot, releaseManifest.extensionArchive);
  if (!existsSync(archivePath)) {
    throw new Error(
      `Chrome Web Store extension archive was not found at ${archivePath}. Run npm run package:release first.`
    );
  }

  const archiveBytes = readFileSync(archivePath);
  const accessToken = await exchangeServiceAccountToken(
    config.serviceAccount,
    fetchImpl,
    nowSeconds
  );
  const submissionGuard = await ensureSubmissionCanProceed(
    config,
    accessToken,
    fetchImpl,
    log,
    waitMs,
    pollIntervalMs,
    maxUploadPollAttempts
  );
  if (submissionGuard.skipped) {
    return null;
  }
  logChromeWebStoreItemWarnings(config, submissionGuard.status, log);

  if (config.dryRun) {
    log.log(
      `Dry run: verified Chrome Web Store access for item ${config.itemId}; would upload ${toProjectRelative(projectRoot, archivePath)} and publish version ${releaseManifest.version}.`
    );
    return null;
  }

  const uploadResponse = await uploadExtensionArchive(config, accessToken, archiveBytes, fetchImpl);

  if (uploadResponse.uploadState === 'FAILED' || uploadResponse.uploadState === 'NOT_FOUND') {
    throw new Error(
      `Chrome Web Store upload finished immediately in state ${uploadResponse.uploadState}.`
    );
  }
  if (uploadResponse.uploadState !== 'SUCCEEDED' && uploadResponse.uploadState !== 'IN_PROGRESS') {
    throw new Error(
      `Chrome Web Store upload returned unknown state ${uploadResponse.uploadState}.`
    );
  }

  if (uploadResponse.crxVersion && uploadResponse.crxVersion !== releaseManifest.version) {
    throw new Error(
      `Chrome Web Store accepted version ${uploadResponse.crxVersion}, but release artifacts expect ${releaseManifest.version}.`
    );
  }

  const status =
    uploadResponse.uploadState === 'IN_PROGRESS'
      ? await waitForUploadCompletion(
          config,
          accessToken,
          fetchImpl,
          waitMs,
          pollIntervalMs,
          maxUploadPollAttempts
        )
      : undefined;

  if (status) {
    logChromeWebStoreItemWarnings(config, status, log);
  }

  const publishResponse = await publishItem(config, accessToken, fetchImpl);
  if (!SUCCESSFUL_PUBLISH_STATES.has(publishResponse.state)) {
    throw new Error(
      `Chrome Web Store publish returned unexpected item state ${publishResponse.state}.`
    );
  }

  log.log(
    `Published ${toProjectRelative(projectRoot, archivePath)} to Chrome Web Store item ${config.itemId} (${publishResponse.state}).`
  );

  return {
    version: releaseManifest.version,
    itemId: config.itemId,
    uploadState:
      uploadResponse.uploadState === 'IN_PROGRESS' ? 'SUCCEEDED' : uploadResponse.uploadState,
    publishState: publishResponse.state,
  };
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2]
    ? resolve(PROJECT_ROOT, process.argv[2])
    : DEFAULT_RELEASE_MANIFEST_PATH;
  await publishChromeWebStoreRelease({ manifestPath });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[publish-chrome-web-store] ${message}`);
    process.exit(1);
  });
}
