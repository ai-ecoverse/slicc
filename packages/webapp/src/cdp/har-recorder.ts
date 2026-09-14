import { createLogger } from '../base/logger.js';
import type { VirtualFS } from '../fs/index.js';
import { throwIfAborted } from './command-abort.js';
import type { CDPTransport } from './transport.js';
import type { CDPEventListener } from './types.js';

const log = createLogger('har-recorder');

export type HarCache = Record<string, never>;

interface HarNetworkRequestWillBeSentParams {
  sessionId?: string;
  requestId?: string;
  timestamp?: number;
  request?: PendingRequest['request'];
}

interface HarNetworkResponseReceivedParams {
  sessionId?: string;
  requestId?: string;
  response?: NonNullable<PendingRequest['response']> & {
    timing?: PendingRequest['timing'];
  };
}

interface HarNetworkLoadingFinishedParams {
  sessionId?: string;
  requestId?: string;
  timestamp?: number;
}

interface HarNetworkLoadingFailedParams {
  sessionId?: string;
  requestId?: string;
}

interface HarPageFrameNavigatedParams {
  sessionId?: string;
  frame?: { parentId?: string; url?: string };
}

interface HarRuntimeEvaluateResult {
  result?: { value?: string };
}

interface HarNetworkGetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  entries: HarEntry[];
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: HarCache;
  timings: HarTimings;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  queryString: HarQueryParam[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  send: number;
  wait: number;
  receive: number;
  ssl: number;
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
}

export interface HarQueryParam {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text?: string;
  params?: Array<{ name: string; value?: string; fileName?: string; contentType?: string }>;
}

interface PendingRequest {
  requestId: string;
  startTime: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    postData?: string;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType?: string;
  };
  responseBody?: string;
  responseBodyBase64?: boolean;
  timing?: {
    requestTime: number;
    proxyStart: number;
    proxyEnd: number;
    dnsStart: number;
    dnsEnd: number;
    connectStart: number;
    connectEnd: number;
    sslStart: number;
    sslEnd: number;
    sendStart: number;
    sendEnd: number;
    receiveHeadersStart: number;
    receiveHeadersEnd: number;
  };
  endTime?: number;
}

export type HarFilterFn = (entry: HarEntry) => boolean | HarEntry;

export interface RecordingSession {
  id: string;
  targetId: string;
  sessionId: string;
  filterCode?: string;
  pendingRequests: Map<string, PendingRequest>;
  entries: HarEntry[];
  startTime: number;
  currentUrl: string;
  snapshotCount: number;
}

export class HarRecorder {
  private recordings = new Map<string, RecordingSession>();
  private client: CDPTransport;
  private fs: VirtualFS;
  private eventCleanup = new Map<string, () => void>();

  constructor(client: CDPTransport, fs: VirtualFS) {
    this.client = client;
    this.fs = fs;
  }

  async startRecording(
    targetId: string,
    sessionId: string,
    filterCode?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    throwIfAborted(signal, `about to enable Network on tab ${targetId}`);
    await this.client.send('Network.enable', {}, sessionId);
    throwIfAborted(signal, `about to enable Page on tab ${targetId}`);
    await this.client.send('Page.enable', {}, sessionId);

    throwIfAborted(signal, `about to read the URL of tab ${targetId}`);
    const pageInfo = (await this.client.send(
      'Runtime.evaluate',
      {
        expression: 'location.href',
        returnByValue: true,
      },
      sessionId
    )) as HarRuntimeEvaluateResult;
    const currentUrl = pageInfo.result?.value ?? 'about:blank';

    const session: RecordingSession = {
      id: recordingId,
      targetId,
      sessionId,
      filterCode,
      pendingRequests: new Map(),
      entries: [],
      startTime: Date.now(),
      currentUrl,
      snapshotCount: 0,
    };

    this.recordings.set(recordingId, session);

    this.setupEventListeners(session);

    await this.ensureDir(`/recordings/${recordingId}`);

    log.debug('Started recording', { recordingId, targetId, currentUrl });

    return recordingId;
  }

  private setupEventListeners(session: RecordingSession): void {
    const { sessionId, id: recordingId } = session;

    const onRequestWillBeSent: CDPEventListener = (raw) => {
      const params = raw as HarNetworkRequestWillBeSentParams;
      if (params.sessionId !== sessionId) return;
      this.handleRequestWillBeSent(session, params);
    };

    const onResponseReceived: CDPEventListener = (raw) => {
      const params = raw as HarNetworkResponseReceivedParams;
      if (params.sessionId !== sessionId) return;
      this.handleResponseReceived(session, params);
    };

    const onLoadingFinished: CDPEventListener = (raw) => {
      const params = raw as HarNetworkLoadingFinishedParams;
      if (params.sessionId !== sessionId) return;
      void this.handleLoadingFinished(session, params).catch((err) => {
        log.error('Failed to process loadingFinished event', {
          recordingId,
          requestId: params.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    const onLoadingFailed: CDPEventListener = (raw) => {
      const params = raw as HarNetworkLoadingFailedParams;
      if (params.sessionId !== sessionId) return;
      this.handleLoadingFailed(session, params);
    };

    const onFrameNavigated: CDPEventListener = (raw) => {
      const params = raw as HarPageFrameNavigatedParams;
      if (params.sessionId !== sessionId) return;
      const frame = params.frame;

      if (!frame?.parentId && frame?.url) {
        const entriesToSave = [...session.entries];
        const urlForSnapshot = session.currentUrl;
        session.currentUrl = frame.url;
        session.entries = [];
        session.pendingRequests.clear();

        this.saveSnapshotWithEntries(session, 'navigation', entriesToSave, urlForSnapshot).catch(
          (err) => {
            log.error('Failed to save navigation snapshot', {
              recordingId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        );
      }
    };

    this.client.on('Network.requestWillBeSent', onRequestWillBeSent);
    this.client.on('Network.responseReceived', onResponseReceived);
    this.client.on('Network.loadingFinished', onLoadingFinished);
    this.client.on('Network.loadingFailed', onLoadingFailed);
    this.client.on('Page.frameNavigated', onFrameNavigated);

    this.eventCleanup.set(recordingId, () => {
      this.client.off('Network.requestWillBeSent', onRequestWillBeSent);
      this.client.off('Network.responseReceived', onResponseReceived);
      this.client.off('Network.loadingFinished', onLoadingFinished);
      this.client.off('Network.loadingFailed', onLoadingFailed);
      this.client.off('Page.frameNavigated', onFrameNavigated);
    });
  }

  private handleRequestWillBeSent(
    session: RecordingSession,
    params: HarNetworkRequestWillBeSentParams
  ): void {
    const { requestId, request, timestamp } = params;
    if (!requestId || !request || timestamp == null) return;

    session.pendingRequests.set(requestId, {
      requestId,
      startTime: timestamp * 1000,
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers,
        postData: request.postData,
      },
    });
  }

  private handleResponseReceived(
    session: RecordingSession,
    params: HarNetworkResponseReceivedParams
  ): void {
    const { requestId, response } = params;
    if (!requestId || !response) return;

    const pending = session.pendingRequests.get(requestId);
    if (pending) {
      pending.response = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        mimeType: response.mimeType,
      };
      pending.timing = response.timing;
    }
  }

  private async handleLoadingFinished(
    session: RecordingSession,
    params: HarNetworkLoadingFinishedParams
  ): Promise<void> {
    const { requestId, timestamp } = params;
    if (!requestId || timestamp == null) return;

    const pending = session.pendingRequests.get(requestId);
    if (!pending) return;

    pending.endTime = timestamp * 1000;

    try {
      const bodyResult = (await this.client.send(
        'Network.getResponseBody',
        { requestId },
        session.sessionId
      )) as HarNetworkGetResponseBodyResult;
      pending.responseBody = bodyResult.body;
      pending.responseBodyBase64 = bodyResult.base64Encoded === true;
    } catch {}

    const entry = this.buildHarEntry(pending);
    if (entry) {
      session.entries.push(entry);
    }

    session.pendingRequests.delete(requestId);
  }

  private handleLoadingFailed(
    session: RecordingSession,
    params: HarNetworkLoadingFailedParams
  ): void {
    const { requestId } = params;
    if (!requestId) return;
    session.pendingRequests.delete(requestId);
  }

  private buildHarEntry(pending: PendingRequest): HarEntry | null {
    if (!pending.response) return null;

    const { request, response, timing, startTime, endTime, responseBody, responseBodyBase64 } =
      pending;
    const duration = endTime ? endTime - startTime : 0;

    let queryString: HarQueryParam[] = [];
    try {
      const url = new URL(request.url);
      queryString = Array.from(url.searchParams.entries()).map(([name, value]) => ({
        name,
        value,
      }));
    } catch {}

    const timings: HarTimings = timing
      ? (() => {
          const phaseDuration = (start?: number, end?: number): number => {
            if (start == null || end == null || start < 0 || end < 0) return -1;
            const value = end - start;
            return value >= 0 ? value : -1;
          };

          const blockedEnd =
            timing.dnsStart >= 0
              ? timing.dnsStart
              : timing.connectStart >= 0
                ? timing.connectStart
                : 0;
          return {
            blocked: blockedEnd > 0 ? blockedEnd : -1,
            dns: phaseDuration(timing.dnsStart, timing.dnsEnd),
            connect: phaseDuration(timing.connectStart, timing.connectEnd),
            ssl: phaseDuration(timing.sslStart, timing.sslEnd),
            send: phaseDuration(timing.sendStart, timing.sendEnd),
            wait: phaseDuration(timing.sendEnd, timing.receiveHeadersStart),
            receive: phaseDuration(timing.receiveHeadersStart, timing.receiveHeadersEnd),
          };
        })()
      : {
          blocked: -1,
          dns: -1,
          connect: -1,
          ssl: -1,
          send: 0,
          wait: duration,
          receive: 0,
        };

    const content: HarContent = {
      size: responseBody?.length ?? 0,
      mimeType: response.mimeType ?? 'application/octet-stream',
    };
    if (responseBody) {
      content.text = responseBody;
      if (responseBodyBase64) {
        content.encoding = 'base64';
      }
    }

    let postData: HarPostData | undefined;
    if (request.postData) {
      const contentType =
        request.headers['content-type'] ?? request.headers['Content-Type'] ?? 'text/plain';
      postData = {
        mimeType: contentType,
        text: request.postData,
      };
    }

    return {
      startedDateTime: new Date(startTime).toISOString(),
      time: duration,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: Object.entries(request.headers).map(([name, value]) => ({ name, value })),
        queryString,
        postData,
        headersSize: -1,
        bodySize: request.postData?.length ?? 0,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: Object.entries(response.headers).map(([name, value]) => ({ name, value })),
        content,
        redirectURL: response.headers['location'] ?? response.headers['Location'] ?? '',
        headersSize: -1,
        bodySize: content.size,
      },
      cache: {},
      timings,
    };
  }

  async saveSnapshot(
    session: RecordingSession,
    trigger: 'navigation' | 'close'
  ): Promise<string | null> {
    return this.saveSnapshotWithEntries(session, trigger, session.entries, session.currentUrl);
  }

  private async applyFilter(entries: HarEntry[], filterCode: string): Promise<HarEntry[]> {
    return applyFilterDirect(entries, filterCode);
  }

  private async saveSnapshotWithEntries(
    session: RecordingSession,
    trigger: 'navigation' | 'close',
    entries: HarEntry[],
    url: string
  ): Promise<string | null> {
    if (entries.length === 0) {
      log.debug('No entries to save', { recordingId: session.id, trigger });
      return null;
    }

    const filteredEntries = session.filterCode
      ? await this.applyFilter(entries, session.filterCode)
      : entries;

    if (filteredEntries.length === 0) {
      log.debug('All entries filtered out', { recordingId: session.id, trigger });
      return null;
    }

    session.snapshotCount++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const urlSlug = this.urlToSlug(url);
    const filename = `${session.snapshotCount.toString().padStart(3, '0')}-${timestamp}-${trigger}-${urlSlug}.har`;
    const path = `/recordings/${session.id}/${filename}`;

    const har = {
      log: {
        version: '1.2',
        creator: { name: 'SLICC HAR Recorder', version: '1.0.0' },
        entries: filteredEntries,
      } as HarLog,
    };

    await this.fs.writeFile(path, JSON.stringify(har, null, 2));
    log.debug('Saved HAR snapshot', {
      recordingId: session.id,
      path,
      entryCount: filteredEntries.length,
    });

    return path;
  }

  private urlToSlug(url: string): string {
    try {
      const parsed = new URL(url);
      const slug = `${parsed.hostname}${parsed.pathname}`
        .replace(/[^a-zA-Z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
      return slug || 'page';
    } catch {
      return 'page';
    }
  }

  async stopRecording(recordingId: string): Promise<string> {
    const session = this.recordings.get(recordingId);
    if (!session) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    await this.saveSnapshot(session, 'close');

    const cleanup = this.eventCleanup.get(recordingId);
    if (cleanup) {
      cleanup();
      this.eventCleanup.delete(recordingId);
    }

    try {
      await this.client.send('Network.disable', {}, session.sessionId);
    } catch {}

    this.recordings.delete(recordingId);

    const recordingsPath = `/recordings/${recordingId}`;
    log.debug('Stopped recording', { recordingId, snapshotCount: session.snapshotCount });

    return recordingsPath;
  }

  getRecording(recordingId: string): RecordingSession | undefined {
    return this.recordings.get(recordingId);
  }

  getRecordingByTarget(targetId: string): string | undefined {
    for (const [id, session] of this.recordings) {
      if (session.targetId === targetId) {
        return id;
      }
    }
    return undefined;
  }

  private async ensureDir(path: string): Promise<void> {
    await this.fs.mkdir(path, { recursive: true });
  }
}

export function applyFilterDirect(entries: HarEntry[], filterCode: string): HarEntry[] {
  try {
    const filterFn = new Function('entry', `return (${filterCode})(entry);`) as HarFilterFn;
    const result: HarEntry[] = [];
    for (const entry of entries) {
      try {
        const filterResult = filterFn(entry);
        if (filterResult === false) continue;
        if (typeof filterResult === 'object' && filterResult !== null) {
          result.push(filterResult as HarEntry);
        } else {
          result.push(entry);
        }
      } catch (err) {
        log.error('Filter function error on entry, keeping it', {
          error: err instanceof Error ? err.message : String(err),
        });
        result.push(entry);
      }
    }
    return result;
  } catch (err) {
    log.error('Failed to compile filter, returning unfiltered', {
      error: err instanceof Error ? err.message : String(err),
    });
    return entries;
  }
}
