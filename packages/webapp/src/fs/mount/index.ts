// Barrel for the mount module.

export type {
  DaSignAndForwardEnvelope,
  S3SignAndForwardEnvelope,
  SecretGetter,
  SignAndForwardErrorCode,
  SignAndForwardFailure,
  SignAndForwardReply,
  SignAndForwardSuccess,
  SigV4Credentials,
  SigV4Request,
} from '@slicc/shared-ts';
export { executeDaSignAndForward, executeS3SignAndForward, signSigV4 } from '@slicc/shared-ts';
export type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountKind,
  MountStat,
  RefreshReport,
} from './backend.js';
export type { DaMountBackendOptions, SignedFetchDa, SignedFetchDaRequest } from './backend-da.js';
export { DaMountBackend } from './backend-da.js';
export type { LocalMountBackendOptions } from './backend-local.js';
export { LocalMountBackend } from './backend-local.js';
export type { S3MountBackendOptions, SignedFetchS3, SignedFetchS3Request } from './backend-s3.js';
export { S3MountBackend } from './backend-s3.js';
export type { FetchBudgetOptions } from './fetch-with-budget.js';
export { fetchWithBudget } from './fetch-with-budget.js';
export { newMountId } from './mount-id.js';
export type { AdobeImsClient, DaProfile, S3Profile, SecretStore } from './profile.js';
export {
  getDefaultImsClient,
  getDefaultSecretStore,
  ProfileNotConfiguredError,
  resolveDaProfile,
  resolveS3Profile,
} from './profile.js';
export type { CachedBody, CachedListing, RemoteMountCacheOptions } from './remote-cache.js';
export { RemoteMountCache } from './remote-cache.js';
export { makeSignedFetchDa, makeSignedFetchS3 } from './signed-fetch.js';
