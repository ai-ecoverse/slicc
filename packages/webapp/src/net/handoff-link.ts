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
