import type { HandoffMatch } from '../../../net/handoff-link.js';
import type { ParsedLink } from '../../../net/link-header.js';

import type { createServeCommand } from '../serve-command.js';

export type BrowserAPI = NonNullable<Parameters<typeof createServeCommand>[0]>;

export type TabHandle = Parameters<Parameters<BrowserAPI['withTab']>[1]>[0];
type HarRecorder = ReturnType<BrowserAPI['createHarRecorder']>;

export type PageInfo = Awaited<ReturnType<BrowserAPI['listPages']>>[number];
export type FrameInfo = Awaited<ReturnType<TabHandle['getFrameTree']>>[number];

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

export type TeleportPhase =
  | 'armed'
  | 'teleporting'
  | 'waitingForAuth'
  | 'waitingForReturn'
  | 'capturing'
  | 'done'
  | 'timedOut';

export interface TeleportWatcher {
  startPattern: RegExp;
  returnPattern: RegExp;
  timeoutMs: number;
  runtimeId?: string;

  teleportUrl?: string;
  phase: TeleportPhase;

  leaderTargetId?: string;

  followerTargetId?: string;

  originalLeaderUrl?: string;

  completionPromise?: Promise<string>;
  resolveBlock?: (result: string) => void;
  rejectBlock?: (err: Error) => void;

  pollInterval?: ReturnType<typeof setInterval>;

  timeoutTimer?: ReturnType<typeof setTimeout>;

  cleanupListener?: () => void;

  followerStorageScript?: import('./teleport-storage.js').TeleportStorageScript | null;

  lastFollowerDiagnosticKey?: string;

  lastFollowerUrl?: string;
}

export interface ConsoleMessage {
  level: string;
  text: string;
  timestamp: number;
}

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

  responseBodyBase64: boolean;
  mimeType: string | null;
  isStatic: boolean;
  timestamp: number;
}

export interface TabSnapshot {
  url: string;
  title: string;
  refToSelector: Map<string, string>;
  refToBackendNodeId: Map<string, number>;
  refToFrameId: Map<string, string>;
  content: string;
  timestamp: number;
}

export interface RouteEntry {
  pattern: string;

  regex: RegExp;

  status: number;

  body: string;

  contentType: string;

  headers: Record<string, string>;
}

export interface PlaywrightState {
  snapshots: Map<string, TabSnapshot>;

  appTabId: string | null;

  harRecorder: HarRecorder | null;

  sessionDirsCreated: boolean;

  teleportWatchers: Map<string, TeleportWatcher>;

  consoleMessages: Map<string, ConsoleMessage[]>;

  consoleCleanup: Map<string, () => void>;

  networkRequests: Map<string, NetworkEntry[]>;

  networkRequestIndex: Map<string, Map<string, NetworkEntry>>;

  networkCleanup: Map<string, () => void>;

  routes: Map<string, RouteEntry[]>;

  routeCleanup: Map<string, () => void>;

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

export interface BrowseShSkillMatch {
  slug: string;

  name?: string;
  title: string;
  recommendedMethod?: string;

  installed: boolean;
  installHint: string;
}

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

    browseShSkills?: BrowseShSkillMatch[];
  };

  error?: string;

  browseShWarning?: string;
}

export interface PlaywrightHandlerCtx {
  browser: BrowserAPI;
  fs: import('../../../fs/index.js').VirtualFS;
  state: PlaywrightState;
  positional: string[];
  flags: Record<string, string>;

  scratchDir: string;

  onTab: <T>(targetId: string, fn: (tab: TabHandle) => Promise<T>) => Promise<T>;

  signal?: AbortSignal | undefined;
}

export type PlaywrightHandler = (ctx: PlaywrightHandlerCtx) => Promise<CmdResult>;
