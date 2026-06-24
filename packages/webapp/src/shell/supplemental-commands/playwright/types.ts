/**
 * Shared types for the playwright-cli command family.
 */

import type { HarRecorder } from '../../../cdp/index.js';
import type { HandoffMatch } from '../../../net/handoff-link.js';
import type { ParsedLink } from '../../../net/link-header.js';
import type { FloatType } from '../../../scoops/tray-leader-sync.js';

export type CmdResult = { stdout: string; stderr: string; exitCode: number };

export type GetBestFollowerFn = () => {
  runtimeId: string;
  bootstrapId: string;
  floatType: FloatType;
} | null;

export type GetConnectedFollowersFn = () => {
  runtimeId: string;
  runtime?: string;
  connectedAt?: string;
  lastActivity?: number;
  floatType?: FloatType;
}[];

/** Teleport watcher state machine phases. */
export type TeleportPhase =
  | 'armed'
  | 'teleporting'
  | 'waitingForAuth'
  | 'waitingForReturn'
  | 'capturing'
  | 'done'
  | 'timedOut';

/** Teleport watcher that monitors leader tab navigation and triggers auth-state teleport. */
export interface TeleportWatcher {
  startPattern: RegExp;
  returnPattern: RegExp;
  timeoutMs: number;
  runtimeId?: string;
  /** URL to open on the follower when start pattern triggers. If unset, uses the leader tab's current URL. */
  teleportUrl?: string;
  phase: TeleportPhase;
  /** The leader tab being monitored. */
  leaderTargetId?: string;
  /** The composite targetId of the follower tab (runtimeId:localTargetId). */
  followerTargetId?: string;
  /** The leader tab's URL before the SSO redirect, for navigation after auth-state injection. */
  originalLeaderUrl?: string;
  /** Promise that resolves/rejects when the teleport cycle completes. */
  completionPromise?: Promise<string>;
  resolveBlock?: (result: string) => void;
  rejectBlock?: (err: Error) => void;
  /** Interval for polling leader tab URL. */
  pollInterval?: ReturnType<typeof setInterval>;
  /** Timeout timer for the entire teleport cycle. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** CDP event listener cleanup function. */
  cleanupListener?: () => void;
  /** Cleanup function for the follower storage replay script. */
  removeFollowerStorageScript?: (() => Promise<void>) | null;
  /** Dedup key for callback/error diagnostics while polling the follower. */
  lastFollowerDiagnosticKey?: string;
  /** Last follower URL observed during teleport polling. */
  lastFollowerUrl?: string;
}

/** One captured console message from a browser tab. */
export interface ConsoleMessage {
  level: string;
  text: string;
  timestamp: number;
}

/** One captured network request/response pair. */
export interface NetworkEntry {
  index: number;
  requestId: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  mimeType: string | null;
  isStatic: boolean;
  timestamp: number;
}

/** Per-tab snapshot: accessibility tree with element refs. */
export interface TabSnapshot {
  url: string;
  title: string;
  refToSelector: Map<string, string>;
  refToBackendNodeId: Map<string, number>;
  refToFrameId: Map<string, string>;
  content: string;
  timestamp: number;
}

/** Shared state across invocations (persists for the lifetime of the shell). */
export interface PlaywrightState {
  /** Per-tab snapshots keyed by targetId */
  snapshots: Map<string, TabSnapshot>;
  /** App tab ID to exclude */
  appTabId: string | null;
  /** HAR recorder instance (created lazily) */
  harRecorder: HarRecorder | null;
  /** Whether /.playwright/ directories have been created */
  sessionDirsCreated: boolean;
  /** Active teleport watchers keyed by targetId. */
  teleportWatchers: Map<string, TeleportWatcher>;
  /** Captured console messages keyed by targetId. Populated lazily on first `console` call. */
  consoleMessages: Map<string, ConsoleMessage[]>;
  /** CDP event listener cleanup functions keyed by targetId, for console capture. */
  consoleCleanup: Map<string, () => void>;
  /** Captured network requests keyed by targetId. Populated lazily on first `requests` call. */
  networkRequests: Map<string, NetworkEntry[]>;
  /** CDP event listener cleanup functions keyed by targetId, for network capture. */
  networkCleanup: Map<string, () => void>;
}

export interface TeleportStorageSnapshot {
  origin: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface TeleportPageDiagnostics {
  url: string;
  title: string;
  bodySnippet: string;
}

/** One browse.sh catalog match for the destination hostname. */
export interface BrowseShSkillMatch {
  slug: string;
  /** Skill name as published in browse.sh's catalog (frontmatter `name`). */
  name?: string;
  title: string;
  recommendedMethod?: string;
  /** True when `/workspace/skills/browse-{hostname}-{name}` already exists. */
  installed: boolean;
  installHint: string;
}

/** Shape returned to scoops when a fetch/navigation surfaces Link headers. */
export interface PlaywrightDiscoveryResult {
  url: string;
  status?: number;
  links: ParsedLink[];
  handoff: HandoffMatch | null;
  discovery?: {
    catalog?: unknown;
    serviceDesc?: unknown;
    serviceMeta?: unknown;
    status?: unknown;
    llmsTxt?: string;
    failures: Array<{ rel: string; href: string; error: string }>;
    /**
     * browse.sh skills whose hostname matches the destination URL. Omitted
     * when the catalog fetch fails (a warning is surfaced on stderr instead)
     * or when no catalog entry matches the destination's hostname.
     */
    browseShSkills?: BrowseShSkillMatch[];
  };
  /**
   * Populated when the primary fetch itself failed but the command still
   * needs to surface a structured result (so `links: []` is meaningful).
   */
  error?: string;
  /**
   * Non-fatal warning string surfaced when the browse.sh catalog fetch
   * itself failed during `--discover`. Callers should pipe this to stderr;
   * it never blocks navigation.
   * @internal — not part of the JSON payload emitted to scoops.
   */
  browseShWarning?: string;
}

/** Per-handler context shared by every playwright subcommand handler. */
export interface PlaywrightHandlerCtx {
  browser: import('../../../cdp/index.js').BrowserAPI;
  fs: import('../../../fs/index.js').VirtualFS;
  state: PlaywrightState;
  positional: string[];
  flags: Record<string, string>;
}

export type PlaywrightHandler = (ctx: PlaywrightHandlerCtx) => Promise<CmdResult>;
