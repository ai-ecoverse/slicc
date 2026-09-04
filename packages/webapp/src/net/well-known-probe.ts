/**
 * Well-known probe for ARD artifacts — moved to @slicc/shared-ts (#2276
 * slice E) so the thin chrome extension can import it without reaching
 * into packages/webapp/src. Re-exported here so no webapp-internal import
 * path changes.
 */

export type {
  DiscoveryProbeMatch,
  ProbeFetch,
  ProbeOptions,
  ProbeResponse,
} from '@slicc/shared-ts';
export { contentTypeOk, probeWellKnown } from '@slicc/shared-ts';
