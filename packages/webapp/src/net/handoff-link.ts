/**
 * SLICC handoff link extractor — moved to @slicc/shared-ts (#2276 slice E)
 * so the thin chrome extension can import it without reaching into
 * packages/webapp/src. Re-exported here so no webapp-internal import path
 * changes.
 */

export type { CdpHeaderBag, HandoffMatch, HandoffVerb } from '@slicc/shared-ts';
export {
  extractHandoff,
  extractHandoffFromCdpHeaders,
  extractHandoffFromFetchHeaders,
  extractHandoffFromWebRequest,
  HANDOFF_REL,
  handoffFingerprint,
  isSafeUpskillBranch,
  isSafeUpskillPath,
  UPSKILL_REL,
} from '@slicc/shared-ts';
