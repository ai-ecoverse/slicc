/**
 * Shared types for the playwright-cli command family.
 */

import type { HandoffMatch } from '../../../net/handoff-link.js';
import type { ParsedLink } from '../../../net/link-header.js';
// BrowserAPI / HarRecorder are named via `createServeCommand`'s parameter
// (same shell layer) rather than imported from `cdp/`, so this module stays
// inside the shell layer (see layer-stack import direction). FloatType is
// declared here for the same reason — importing it from `scoops/` would be a
// back-edge; the string union is identical to the scoops definition.
import type { createServeCommand } from '../serve-command.js';

/** The cdp BrowserAPI, named without a cdp import (see layer note above). */
export type BrowserAPI = NonNullable<Parameters<typeof createServeCommand>[0]>;

/**
 * The cdp `TabHandle` — the session-explicit page API `withTab` hands its
 * callback. Derived from `withTab`'s own signature rather than imported from
 * `cdp/`, for the same layer reason as {@link BrowserAPI}. Every page
 * operation a handler performs goes through one of these; nothing reads a
 * bridge-wide "current tab" cursor, which is what lets commands on different
 * tabs run concurrently.
 */
export type TabHandle = Parameters<Parameters<BrowserAPI['withTab']>[1]>[0];
type HarRecorder = ReturnType<BrowserAPI['createHarRecorder']>;

/** cdp PageInfo / FrameInfo, derived the same layer-safe way. */
export type PageInfo = Awaited<ReturnType<BrowserAPI['listPages']>>[number];
export type FrameInfo = Awaited<ReturnType<TabHandle['getFrameTree']>>[number];

/** Runtime float kind; mirrors scoops/tray-leader without importing up-stack. */
export type FloatType = 'standalone' | 'extension' | 'electron' | 'ios' | 'unknown';

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
  /** The follower's installed storage-replay init script, for later removal. */
  followerStorageScript?: import('./teleport-storage.js').TeleportStorageScript | null;
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
  /**
   * Whether `responseBody` is base64 (CDP `Network.getResponseBody.base64Encoded`).
   * Kept verbatim from the CDP result — MIME type never decides the encoding.
   */
  responseBodyBase64: boolean;
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

/** One active mock route entry for a tab. */
export interface RouteEntry {
  /** URL pattern (glob-style: ** matches any, * matches within path segment). */
  pattern: string;
  /** Pre-compiled regex for the pattern (compiled once at insertion). */
  regex: RegExp;
  /** HTTP status code to respond with. Default 200. */
  status: number;
  /** Response body text. Default empty string. */
  body: string;
  /** Content-Type header value. Default 'text/plain'. */
  contentType: string;
  /** Extra response headers to add. */
  headers: Record<string, string>;
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
  /** O(1) requestId index: targetId → (requestId → entry). Kept in sync with networkRequests. */
  networkRequestIndex: Map<string, Map<string, NetworkEntry>>;
  /** CDP event listener cleanup functions keyed by targetId, for network capture. */
  networkCleanup: Map<string, () => void>;
  /** Active mock routes keyed by targetId. Populated lazily on first `route` call. */
  routes: Map<string, RouteEntry[]>;
  /** CDP Fetch domain cleanup functions keyed by targetId. Disables interception on call. */
  routeCleanup: Map<string, () => void>;
  /** Last known mouse position per targetId, updated by mousemove. Used by mousedown/mouseup/mousewheel. */
  lastMousePosition: Map<string, { x: number; y: number }>;
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
  browser: BrowserAPI;
  fs: import('../../../fs/index.js').VirtualFS;
  state: PlaywrightState;
  positional: string[];
  flags: Record<string, string>;
  /**
   * Where a subcommand puts default-named output (`scratchDir`,
   * `shell/tmpdir-env.ts`) — the calling unit's own scratch directory, so two
   * cones taking a screenshot in the same second do not collide on
   * `/tmp/screenshot-<ts>.png` and each cone's "New chat" disposes of its own
   * (#2267). An explicit `--filename` still wins.
   */
  scratchDir: string;
  /**
   * `browser.withTab` with this invocation's {@link signal} already bound —
   * the way a handler takes a tab hold.
   *
   * Bound once by the dispatcher rather than repeated at each of the ~60 call
   * sites so a new handler cannot forget it: a hold taken without the signal
   * keeps its tab locked and a CDP command in flight after the caller gave
   * up, and lands its side effects on a page nobody is reading any more.
   * `browser.withTab` stays reachable for holds that must OUTLIVE the command
   * (the post-command auto-snapshot).
   */
  onTab: <T>(targetId: string, fn: (tab: TabHandle) => Promise<T>) => Promise<T>;
  /**
   * Cooperative cancellation for this invocation, straight from just-bash's
   * `CommandContext.signal` — it fires when the agent's `bash` tool gives up
   * (turn cancelled, `timeout` reached, `kill <pid>`).
   *
   * {@link onTab} already carries it into the bridge, and the {@link TabHandle}
   * it hands back carries it into every page operation.
   * Read it directly only when a handler owns a step the bridge cannot see.
   */
  signal?: AbortSignal | undefined;
}

export type PlaywrightHandler = (ctx: PlaywrightHandlerCtx) => Promise<CmdResult>;
