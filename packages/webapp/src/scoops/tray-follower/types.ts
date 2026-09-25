import type { TraySudoAttestation, TraySudoDecision, TraySudoKind } from '@slicc/shared-ts';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import type { CDPTransport } from '../../cdp/transport.js';
import type { MessageAttachment } from '../../core/attachments.js';
import type { VirtualFS } from '../../fs/virtual-fs.js';
import type { ExportSpool } from '../../transcript/export-spool.js';
import type { ChatMessage } from '../chat-types.js';
import type {
  ScoopSummary,
  SprinkleSummary,
  TrayModelCatalogEntry,
  TrayModelSelectionState,
  TraySyncCapabilities,
  TrayTargetEntry,
} from '../tray-sync-protocol.js';

export interface FollowerSyncManagerOptions {
  onBiscottoMessageState?: (
    messageId: string,
    state: 'pending' | 'approved' | 'rejected' | 'unanswered'
  ) => void;

  onUserMessageAck?: (ack: {
    messageId: string;
    scoopJid: string;
    state: 'accepted' | 'rejected';
    error?: string;
  }) => void;

  onOwnUserMessageEcho?: (messageId: string, scoopJid: string) => void;

  onSnapshot?: (messages: ChatMessage[], scoopJid: string) => void;

  onUserMessage?: (
    text: string,
    messageId: string,
    scoopJid: string,
    attachments?: MessageAttachment[]
  ) => void;

  onStatus?: (scoopStatus: string, scoopJid?: string) => void;

  onTargetsUpdated?: (targets: TrayTargetEntry[]) => void;

  browserTransport?: CDPTransport;

  browserAPI?: BrowserAPI;

  onDead?: () => void;

  onDisconnect?: (reason: string) => void;

  onLeaderStalled?: (stalled: boolean) => void;

  vfs?: VirtualFS;

  onTargetsChanged?: () => void;

  onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;

  onScoopsList?: (scoops: ScoopSummary[], activeScoopJid: string) => void;

  onModelsList?: (models: TrayModelCatalogEntry[]) => void;

  onModelState?: (state: TrayModelSelectionState) => void;

  onThemeApply?: (themeJson: string | null) => void;

  onSprinkleUpdate?: (sprinkleName: string, data: unknown) => void;

  onSprinkleReloaded?: (sprinkleName: string) => void;

  onCherrySliccEvent?: (name: string, detail?: unknown) => void;

  selfRuntimeId?: string;

  helloCapabilities?: TraySyncCapabilities;

  onOAuthPopupRequest?: (url: string, signal: AbortSignal) => Promise<string | null>;

  sprinkleFetchTimeoutMs?: number;

  makeExportSpool?: (requestId: string) => ExportSpool;

  onSudoApprovalRequest?: (request: {
    requestId: string;
    kind: TraySudoKind;
    detail: string;

    requester?: string;
    suggestedPattern?: string;

    reason?: string;
    scoopName?: string;
    expiresAt: number;
    signal: AbortSignal;
  }) => Promise<SudoApprovalVerdict> | SudoApprovalVerdict;
}

export interface SudoApprovalVerdict {
  decision: TraySudoDecision;
  pattern?: string;
  attestation?: TraySudoAttestation;
}
