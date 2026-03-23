/**
 * HAR (HTTP Archive) recorder for CDP sessions.
 *
 * Records network traffic from browser tabs and saves snapshots to VFS
 * on navigation and when stopRecording() is called.
 * Supports filtering via user-provided JS functions.
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

  /**
   * Start recording network traffic for a tab.
   * @param targetId - The CDP target ID
   * @param sessionId - The CDP session ID (from attachToTarget)
   * @param filterCode - Optional JS code for filter function: `(entry) => false | true | object`
   * @returns Recording ID
   */
  async startRecording(targetId: string, sessionId: string, filterCode?: string): Promise<string> {
    const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Enable Network domain
    await this.client.send('Network.enable', {}, sessionId);
    await this.client.send('Page.enable', {}, sessionId);

    // Get current URL
    const pageInfo = await this.client.send(
      'Runtime.evaluate',
      {
        expression: 'location.href',
        returnByValue: true,
      },
      sessionId
    );
    const currentUrl = (pageInfo['result'] as { value?: string })?.value ?? 'about:blank';

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
        // Capture entries and URL before clearing to avoid race condition
        const entriesToSave = [...session.entries];
        const urlForSnapshot = session.currentUrl;
        session.currentUrl = frame.url;
        session.entries = [];
        session.pendingRequests.clear();
        // Save snapshot with captured data
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

    // Store cleanup function
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
    params: Record<string, unknown>
  ): void {
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

  private async handleLoadingFinished(
    session: RecordingSession,
    params: Record<string, unknown>
  ): Promise<void> {
    const requestId = params['requestId'] as string;
    const timestamp = params['timestamp'] as number;

    const pending = session.pendingRequests.get(requestId);
    if (!pending) return;

    pending.endTime = timestamp * 1000;

    // Fetch response body
    try {
      const bodyResult = await this.client.send(
        'Network.getResponseBody',
        { requestId },
        session.sessionId
      );
      pending.responseBody = bodyResult['body'] as string;
      pending.responseBodyBase64 = bodyResult['base64Encoded'] as boolean;
    } catch {
      // Body might not be available (e.g., for redirects)
    }

    // Build and store HAR entry (filtering applied at snapshot save, not per-entry)
    const entry = this.buildHarEntry(pending);
    if (entry) {
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

    const { request, response, timing, startTime, endTime, responseBody, responseBodyBase64 } =
      pending;
    const duration = endTime ? endTime - startTime : 0;

    // Parse URL for query string
    let queryString: HarQueryParam[] = [];
    try {
      const url = new URL(request.url);
      queryString = Array.from(url.searchParams.entries()).map(([name, value]) => ({
        name,
        value,
      }));
    } catch {
      // Invalid URL
    }

    // Build timings - CDP timing fields are ms offsets from requestTime
    // HAR expects -1 for unavailable phases
    const timings: HarTimings = timing
      ? (() => {
          const phaseDuration = (start?: number, end?: number): number => {
            if (start == null || end == null || start < 0 || end < 0) return -1;
            const value = end - start;
            return value >= 0 ? value : -1;
          };
          // "blocked" is time before DNS starts (or before connect if no DNS)
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

  /**
   * Save a HAR snapshot to the recordings directory.
   */
  async saveSnapshot(
    session: RecordingSession,
    trigger: 'navigation' | 'close'
  ): Promise<string | null> {
    return this.saveSnapshotWithEntries(session, trigger, session.entries, session.currentUrl);
  }

  /**
   * Apply filter to entries. In extension mode, uses the sandbox iframe (CSP-exempt).
   * In non-extension mode, compiles and applies directly.
   * Returns entries unfiltered on error (graceful fallback).
   */
  private async applyFilter(entries: HarEntry[], filterCode: string): Promise<HarEntry[]> {
    const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

    if (isExtensionMode) {
      // Route through sandbox iframe (CSP-exempt, allows Function constructor)
      try {
        let sandbox = document.querySelector('iframe[data-js-tool]') as HTMLIFrameElement | null;
        if (!sandbox) {
          sandbox = document.createElement('iframe');
          sandbox.style.display = 'none';
          sandbox.dataset.jsTool = 'true';
          sandbox.src = chrome.runtime.getURL('sandbox.html');
          document.body.appendChild(sandbox);
          await Promise.race([
            new Promise<void>((resolve) => {
              sandbox!.addEventListener('load', () => resolve(), { once: true });
            }),
            new Promise<void>((_, reject) => {
              setTimeout(() => reject(new Error('Sandbox iframe failed to load')), 5000);
            }),
          ]);
        }

        const id = `har-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const filtered = await new Promise<HarEntry[]>((resolve, reject) => {
          const timeout = setTimeout(() => {
            window.removeEventListener('message', handler);
            reject(new Error('HAR filter sandbox timeout'));
          }, 10000);

          const handler = (event: MessageEvent) => {
            if (event.data?.type === 'har_filter_result' && event.data.id === id) {
              window.removeEventListener('message', handler);
              clearTimeout(timeout);
              if (event.data.error) {
                reject(new Error(event.data.error));
              } else {
                resolve(event.data.entries);
              }
            }
          };

          window.addEventListener('message', handler);
          sandbox!.contentWindow!.postMessage(
            {
              type: 'har_filter',
              id,
              entries,
              filterCode,
            },
            '*'
          );
        });

        return filtered;
      } catch (err) {
        log.error('HAR filter sandbox error, returning unfiltered', {
          error: err instanceof Error ? err.message : String(err),
        });
        return entries;
      }
    } else {
      // Non-extension: compile and apply directly (intentional dynamic eval for developer tool filter)
      try {
        // User-authored HAR filter expression — evaluated via sandbox postMessage in extension mode.
        // The filterCode string comes from the user's har filter command, not from remote input.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: user-provided filter code
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
  }

  /**
   * Save a HAR snapshot with specific entries and URL (used to avoid race conditions).
   */
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

    // Apply filter at save time (deferred from per-entry to batch)
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
    await this.fs.mkdir(path, { recursive: true });
  }
}
