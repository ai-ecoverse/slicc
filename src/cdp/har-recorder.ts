/**
 * HAR (HTTP Archive) recorder for CDP sessions.
 * 
 * Records network traffic from browser tabs and saves snapshots to VFS
 * on navigation and tab close. Supports filtering via user-provided JS functions.
 */

import type { CDPTransport } from './transport.js';
import type { VirtualFS } from '../fs/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('har-recorder');

/** HAR 1.2 format types */
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
  cache: Record<string, unknown>;
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

/** Internal type for tracking in-flight requests */
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

/** Filter function type - can return false (skip), true (keep), or transformed entry */
export type HarFilterFn = (entry: HarEntry) => boolean | HarEntry;

/** Recording session state */
export interface RecordingSession {
  id: string;
  targetId: string;
  sessionId: string;
  filter?: HarFilterFn;
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

  /**
   * Start recording network traffic for a tab.
   * @param targetId - The CDP target ID
   * @param sessionId - The CDP session ID (from attachToTarget)
   * @param filterCode - Optional JS code for filter function: `(entry) => false | true | object`
   * @returns Recording ID
   */
  async startRecording(
    targetId: string,
    sessionId: string,
    filterCode?: string,
  ): Promise<string> {
    const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // Parse filter function if provided
    let filter: HarFilterFn | undefined;
    if (filterCode) {
      try {
        // Create filter function in agent context (synchronous)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const filterFn = new Function('entry', `return (${filterCode})(entry);`) as (entry: HarEntry) => boolean | HarEntry;
        filter = (entry: HarEntry) => {
          try {
            return filterFn(entry);
          } catch (err) {
            log.error('Filter function error', { recordingId, error: err instanceof Error ? err.message : String(err) });
            return true; // Keep entry on error
          }
        };
      } catch (err) {
        throw new Error(`Invalid filter function: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Enable Network domain
    await this.client.send('Network.enable', {}, sessionId);
    await this.client.send('Page.enable', {}, sessionId);

    // Get current URL
    const pageInfo = await this.client.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    }, sessionId);
    const currentUrl = (pageInfo['result'] as { value?: string })?.value ?? 'about:blank';

    const session: RecordingSession = {
      id: recordingId,
      targetId,
      sessionId,
      filter,
      pendingRequests: new Map(),
      entries: [],
      startTime: Date.now(),
      currentUrl,
      snapshotCount: 0,
    };

    this.recordings.set(recordingId, session);

    // Set up event listeners
    this.setupEventListeners(session);

    // Create recordings directory
    await this.ensureDir(`/recordings/${recordingId}`);

    log.debug('Started recording', { recordingId, targetId, currentUrl });

    return recordingId;
  }

  private setupEventListeners(session: RecordingSession): void {
    const { sessionId, id: recordingId } = session;

    // Request handler
    const onRequestWillBeSent = (params: Record<string, unknown>) => {
      if ((params['sessionId'] as string | undefined) !== sessionId) return;
      this.handleRequestWillBeSent(session, params);
    };

    // Response handler
    const onResponseReceived = (params: Record<string, unknown>) => {
      if ((params['sessionId'] as string | undefined) !== sessionId) return;
      this.handleResponseReceived(session, params);
    };

    // Loading finished handler
    const onLoadingFinished = (params: Record<string, unknown>) => {
      if ((params['sessionId'] as string | undefined) !== sessionId) return;
      this.handleLoadingFinished(session, params);
    };

    // Loading failed handler
    const onLoadingFailed = (params: Record<string, unknown>) => {
      if ((params['sessionId'] as string | undefined) !== sessionId) return;
      this.handleLoadingFailed(session, params);
    };

    // Navigation handler - save snapshot
    const onFrameNavigated = (params: Record<string, unknown>) => {
      if ((params['sessionId'] as string | undefined) !== sessionId) return;
      const frame = params['frame'] as { parentId?: string; url?: string } | undefined;
      // Only handle main frame navigations
      if (!frame?.parentId && frame?.url) {
        this.saveSnapshot(session, 'navigation').catch(err => {
          log.error('Failed to save navigation snapshot', { recordingId, error: err instanceof Error ? err.message : String(err) });
        });
        session.currentUrl = frame.url;
        // Clear entries for new page
        session.entries = [];
        session.pendingRequests.clear();
      }
    };

    this.client.on('Network.requestWillBeSent', onRequestWillBeSent);
    this.client.on('Network.responseReceived', onResponseReceived);
    this.client.on('Network.loadingFinished', onLoadingFinished);
    this.client.on('Network.loadingFailed', onLoadingFailed);
    this.client.on('Page.frameNavigated', onFrameNavigated);

    // Store cleanup function
    this.eventCleanup.set(recordingId, () => {
      this.client.off('Network.requestWillBeSent', onRequestWillBeSent);
      this.client.off('Network.responseReceived', onResponseReceived);
      this.client.off('Network.loadingFinished', onLoadingFinished);
      this.client.off('Network.loadingFailed', onLoadingFailed);
      this.client.off('Page.frameNavigated', onFrameNavigated);
    });
  }

  private handleRequestWillBeSent(session: RecordingSession, params: Record<string, unknown>): void {
    const requestId = params['requestId'] as string;
    const request = params['request'] as {
      method: string;
      url: string;
      headers: Record<string, string>;
      postData?: string;
    };
    const timestamp = params['timestamp'] as number;

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

  private handleResponseReceived(session: RecordingSession, params: Record<string, unknown>): void {
    const requestId = params['requestId'] as string;
    const response = params['response'] as {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      mimeType?: string;
      timing?: PendingRequest['timing'];
    };

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

  private async handleLoadingFinished(session: RecordingSession, params: Record<string, unknown>): Promise<void> {
    const requestId = params['requestId'] as string;
    const timestamp = params['timestamp'] as number;

    const pending = session.pendingRequests.get(requestId);
    if (!pending) return;

    pending.endTime = timestamp * 1000;

    // Fetch response body
    try {
      const bodyResult = await this.client.send('Network.getResponseBody', { requestId }, session.sessionId);
      pending.responseBody = bodyResult['body'] as string;
      pending.responseBodyBase64 = bodyResult['base64Encoded'] as boolean;
    } catch {
      // Body might not be available (e.g., for redirects)
    }

    // Build and store HAR entry
    const entry = this.buildHarEntry(pending);
    if (entry) {
      // Apply filter if defined
      if (session.filter) {
        const result = session.filter(entry);
        if (result === false) {
          session.pendingRequests.delete(requestId);
          return;
        }
        if (typeof result === 'object' && result !== null) {
          session.entries.push(result as HarEntry);
          session.pendingRequests.delete(requestId);
          return;
        }
      }
      session.entries.push(entry);
    }

    session.pendingRequests.delete(requestId);
  }

  private handleLoadingFailed(session: RecordingSession, params: Record<string, unknown>): void {
    const requestId = params['requestId'] as string;
    session.pendingRequests.delete(requestId);
  }

  private buildHarEntry(pending: PendingRequest): HarEntry | null {
    if (!pending.response) return null;

    const { request, response, timing, startTime, endTime, responseBody, responseBodyBase64 } = pending;
    const duration = endTime ? endTime - startTime : 0;

    // Parse URL for query string
    let queryString: HarQueryParam[] = [];
    try {
      const url = new URL(request.url);
      queryString = Array.from(url.searchParams.entries()).map(([name, value]) => ({ name, value }));
    } catch {
      // Invalid URL
    }

    // Build timings
    const timings: HarTimings = timing ? {
      blocked: Math.max(0, (timing.dnsStart ?? 0) - (timing.requestTime ?? 0) * 1000),
      dns: Math.max(0, ((timing.dnsEnd ?? 0) - (timing.dnsStart ?? 0))),
      connect: Math.max(0, ((timing.connectEnd ?? 0) - (timing.connectStart ?? 0))),
      ssl: Math.max(0, ((timing.sslEnd ?? 0) - (timing.sslStart ?? 0))),
      send: Math.max(0, ((timing.sendEnd ?? 0) - (timing.sendStart ?? 0))),
      wait: Math.max(0, ((timing.receiveHeadersStart ?? 0) - (timing.sendEnd ?? 0))),
      receive: Math.max(0, ((timing.receiveHeadersEnd ?? 0) - (timing.receiveHeadersStart ?? 0))),
    } : {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: duration,
      receive: 0,
    };

    // Build content
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

    // Build post data
    let postData: HarPostData | undefined;
    if (request.postData) {
      const contentType = request.headers['content-type'] ?? request.headers['Content-Type'] ?? 'text/plain';
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

  /**
   * Save a HAR snapshot to the recordings directory.
   */
  async saveSnapshot(session: RecordingSession, trigger: 'navigation' | 'close'): Promise<string | null> {
    if (session.entries.length === 0) {
      log.debug('No entries to save', { recordingId: session.id, trigger });
      return null;
    }

    session.snapshotCount++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const urlSlug = this.urlToSlug(session.currentUrl);
    const filename = `${session.snapshotCount.toString().padStart(3, '0')}-${timestamp}-${trigger}-${urlSlug}.har`;
    const path = `/recordings/${session.id}/${filename}`;

    const har = {
      log: {
        version: '1.2',
        creator: { name: 'SLICC HAR Recorder', version: '1.0.0' },
        entries: session.entries,
      } as HarLog,
    };

    await this.fs.writeFile(path, JSON.stringify(har, null, 2));
    log.debug('Saved HAR snapshot', { recordingId: session.id, path, entryCount: session.entries.length });

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

  /**
   * Stop recording and save final snapshot.
   * @returns Path to the recordings directory
   */
  async stopRecording(recordingId: string): Promise<string> {
    const session = this.recordings.get(recordingId);
    if (!session) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    // Save final snapshot
    await this.saveSnapshot(session, 'close');

    // Clean up event listeners
    const cleanup = this.eventCleanup.get(recordingId);
    if (cleanup) {
      cleanup();
      this.eventCleanup.delete(recordingId);
    }

    // Disable network domain (best effort)
    try {
      await this.client.send('Network.disable', {}, session.sessionId);
    } catch {
      // Session might already be closed
    }

    this.recordings.delete(recordingId);

    const recordingsPath = `/recordings/${recordingId}`;
    log.debug('Stopped recording', { recordingId, snapshotCount: session.snapshotCount });

    return recordingsPath;
  }

  /**
   * Get recording info.
   */
  getRecording(recordingId: string): RecordingSession | undefined {
    return this.recordings.get(recordingId);
  }

  /**
   * Get recording ID by target ID.
   */
  getRecordingByTarget(targetId: string): string | undefined {
    for (const [id, session] of this.recordings) {
      if (session.targetId === targetId) {
        return id;
      }
    }
    return undefined;
  }

  private async ensureDir(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      try {
        await this.fs.stat(current);
      } catch {
        await this.fs.mkdir(current);
      }
    }
  }
}
