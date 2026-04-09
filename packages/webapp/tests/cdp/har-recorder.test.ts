import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { HarRecorder } from '../../src/cdp/har-recorder.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { CDPEventListener, ConnectionState, CDPConnectOptions } from '../../src/cdp/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

// Mock CDP Transport
class MockCDPTransport implements CDPTransport {
  state: ConnectionState = 'connected';
  private listeners = new Map<string, Set<CDPEventListener>>();
  private sentCommands: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];

  async connect(_options?: CDPConnectOptions): Promise<void> {
    this.state = 'connected';
  }

  disconnect(): void {
    this.state = 'disconnected';
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    this.sentCommands.push({ method, params, sessionId });

    // Mock responses
    if (method === 'Runtime.evaluate') {
      return { result: { value: 'https://example.com/page' } };
    }
    if (method === 'Network.getResponseBody') {
      return { body: '{"data": "test"}', base64Encoded: false };
    }
    return {};
  }

  on(event: string, listener: CDPEventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  async once(event: string, _timeout?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler = (params: Record<string, unknown>) => {
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
    });
  }

  // Test helper: emit an event
  emit(event: string, params: Record<string, unknown>): void {
    this.listeners.get(event)?.forEach((listener) => listener(params));
  }

  // Test helper: get sent commands
  getSentCommands() {
    return this.sentCommands;
  }

  // Test helper: clear sent commands
  clearSentCommands() {
    this.sentCommands = [];
  }
}

let dbCounter = 0;

describe('HarRecorder', () => {
  let transport: MockCDPTransport;
  let fs: VirtualFS;
  let recorder: HarRecorder;

  beforeEach(async () => {
    transport = new MockCDPTransport();
    fs = await VirtualFS.create({
      dbName: `har-test-${dbCounter++}`,
      wipe: true,
    });
    recorder = new HarRecorder(transport, fs);
  });

  afterEach(async () => {
    await fs.dispose();
  });

  describe('startRecording', () => {
    it('creates a recording session and enables Network domain', async () => {
      const recordingId = await recorder.startRecording('target-1', 'session-1');

      expect(recordingId).toMatch(/^rec-/);

      const commands = transport.getSentCommands();
      expect(commands).toContainEqual({
        method: 'Network.enable',
        params: {},
        sessionId: 'session-1',
      });
      expect(commands).toContainEqual({
        method: 'Page.enable',
        params: {},
        sessionId: 'session-1',
      });
    });

    it('creates recordings directory', async () => {
      const recordingId = await recorder.startRecording('target-1', 'session-1');

      const exists = await fs.exists(`/recordings/${recordingId}`);
      expect(exists).toBe(true);
    });

    it('stores invalid filter code without throwing (deferred to save time)', async () => {
      // Invalid filter code is stored as-is; compilation error surfaces at save time
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        'invalid syntax {{{'
      );
      expect(recordingId).toBeTruthy();
      const session = recorder.getRecording(recordingId);
      expect(session?.filterCode).toBe('invalid syntax {{{');
    });

    it('accepts valid filter function', async () => {
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        '(entry) => entry.request.url.includes("api")'
      );
      expect(recordingId).toMatch(/^rec-/);
    });
  });

  describe('network event handling', () => {
    let recordingId: string;

    beforeEach(async () => {
      recordingId = await recorder.startRecording('target-1', 'session-1');
      transport.clearSentCommands();
    });

    it('captures request and response', async () => {
      // Simulate request
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: {
          method: 'GET',
          url: 'https://api.example.com/data',
          headers: { Accept: 'application/json' },
        },
      });

      // Simulate response
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
          mimeType: 'application/json',
        },
      });

      // Simulate loading finished
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      const session = recorder.getRecording(recordingId);
      expect(session?.entries).toHaveLength(1);
      expect(session?.entries[0].request.url).toBe('https://api.example.com/data');
      expect(session?.entries[0].response.status).toBe(200);
    });

    it('ignores events from other sessions', async () => {
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'other-session',
        requestId: 'req-1',
        timestamp: 1000,
        request: {
          method: 'GET',
          url: 'https://example.com',
          headers: {},
        },
      });

      const session = recorder.getRecording(recordingId);
      expect(session?.pendingRequests.size).toBe(0);
    });

    it('handles loading failed', async () => {
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: {
          method: 'GET',
          url: 'https://example.com',
          headers: {},
        },
      });

      transport.emit('Network.loadingFailed', {
        sessionId: 'session-1',
        requestId: 'req-1',
      });

      const session = recorder.getRecording(recordingId);
      expect(session?.pendingRequests.size).toBe(0);
      expect(session?.entries).toHaveLength(0);
    });
  });

  describe('filter function', () => {
    it('excludes entries when filter returns false (applied at save time)', async () => {
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        '(entry) => !entry.request.url.includes("exclude")'
      );

      // Request that should be excluded by filter
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com/exclude', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Entries are stored unfiltered
      const session = recorder.getRecording(recordingId);
      expect(session?.entries).toHaveLength(1);

      // Filter is applied at save time — snapshot should be null (all filtered out)
      const path = await recorder.saveSnapshot(session!, 'close');
      expect(path).toBeNull();
    });

    it('transforms entries when filter returns object (applied at save time)', async () => {
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        '(entry) => ({ ...entry, request: { ...entry.request, url: "transformed" } })'
      );

      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com/original', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Entries stored unfiltered
      const session = recorder.getRecording(recordingId);
      expect(session?.entries[0].request.url).toBe('https://example.com/original');

      // Filter transforms at save time — verify in saved HAR file
      const path = await recorder.saveSnapshot(session!, 'close');
      expect(path).toBeTruthy();
      const harContent = await fs.readFile(path!, { encoding: 'utf-8' });
      const har = JSON.parse(harContent as string);
      expect(har.log.entries[0].request.url).toBe('transformed');
    });

    it('returns unfiltered entries when filter code is invalid (graceful fallback)', async () => {
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        'invalid syntax {{{'
      );

      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com/api', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      const session = recorder.getRecording(recordingId);
      const path = await recorder.saveSnapshot(session!, 'close');
      expect(path).toBeTruthy();
      const harContent = await fs.readFile(path!, { encoding: 'utf-8' });
      const har = JSON.parse(harContent as string);
      expect(har.log.entries).toHaveLength(1);
      expect(har.log.entries[0].request.url).toBe('https://example.com/api');
    });

    it('filters mixed entries, keeping only those that pass', async () => {
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        '(entry) => !entry.request.url.includes("analytics")'
      );

      // Entry that should pass filter
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com/api/data', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      // Entry that should be filtered out
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-2',
        timestamp: 1002,
        request: { method: 'GET', url: 'https://analytics.example.com/track', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-2',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-2',
        timestamp: 1003,
      });

      await new Promise((r) => setTimeout(r, 50));

      const session = recorder.getRecording(recordingId);
      expect(session?.entries).toHaveLength(2);

      const path = await recorder.saveSnapshot(session!, 'close');
      expect(path).toBeTruthy();
      const harContent = await fs.readFile(path!, { encoding: 'utf-8' });
      const har = JSON.parse(harContent as string);
      expect(har.log.entries).toHaveLength(1);
      expect(har.log.entries[0].request.url).toBe('https://example.com/api/data');
    });

    it('keeps entries when filter throws per-entry error', async () => {
      const recordingId = await recorder.startRecording(
        'target-1',
        'session-1',
        '(entry) => entry.nonexistent.property'
      );

      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      const session = recorder.getRecording(recordingId);
      const path = await recorder.saveSnapshot(session!, 'close');
      expect(path).toBeTruthy();
      const harContent = await fs.readFile(path!, { encoding: 'utf-8' });
      const har = JSON.parse(harContent as string);
      expect(har.log.entries).toHaveLength(1);
    });
  });

  describe('saveSnapshot', () => {
    it('saves HAR file on navigation', async () => {
      const recordingId = await recorder.startRecording('target-1', 'session-1');

      // Add an entry
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Simulate navigation (triggers snapshot)
      transport.emit('Page.frameNavigated', {
        sessionId: 'session-1',
        frame: { url: 'https://example.com/new-page' },
      });

      await new Promise((r) => setTimeout(r, 50));

      // Check that snapshot was saved
      const files = await fs.readDir(`/recordings/${recordingId}`);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].name).toContain('navigation');
      expect(files[0].name).toMatch(/\.har$/);
    });
  });

  describe('stopRecording', () => {
    it('saves final snapshot and cleans up', async () => {
      const recordingId = await recorder.startRecording('target-1', 'session-1');

      // Add an entry
      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: { method: 'GET', url: 'https://example.com', headers: {} },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: { status: 200, statusText: 'OK', headers: {} },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      const recordingsPath = await recorder.stopRecording(recordingId);

      expect(recordingsPath).toBe(`/recordings/${recordingId}`);

      // Check that final snapshot was saved
      const files = await fs.readDir(recordingsPath);
      expect(files.some((f) => f.name.includes('close'))).toBe(true);

      // Check that recording is removed
      expect(recorder.getRecording(recordingId)).toBeUndefined();
    });

    it('throws for unknown recording', async () => {
      await expect(recorder.stopRecording('unknown-id')).rejects.toThrow('Recording not found');
    });
  });

  describe('getRecordingByTarget', () => {
    it('finds recording by target ID', async () => {
      const recordingId = await recorder.startRecording('target-1', 'session-1');

      expect(recorder.getRecordingByTarget('target-1')).toBe(recordingId);
      expect(recorder.getRecordingByTarget('unknown')).toBeUndefined();
    });
  });

  describe('HAR format', () => {
    it('builds valid HAR entries with all fields', async () => {
      const recordingId = await recorder.startRecording('target-1', 'session-1');

      transport.emit('Network.requestWillBeSent', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1000,
        request: {
          method: 'POST',
          url: 'https://api.example.com/data?foo=bar&baz=qux',
          headers: { 'Content-Type': 'application/json' },
          postData: '{"key": "value"}',
        },
      });
      transport.emit('Network.responseReceived', {
        sessionId: 'session-1',
        requestId: 'req-1',
        response: {
          status: 201,
          statusText: 'Created',
          headers: { 'Content-Type': 'application/json', Location: '/data/123' },
          mimeType: 'application/json',
        },
      });
      transport.emit('Network.loadingFinished', {
        sessionId: 'session-1',
        requestId: 'req-1',
        timestamp: 1001,
      });

      await new Promise((r) => setTimeout(r, 50));

      const session = recorder.getRecording(recordingId);
      const entry = session?.entries[0];

      expect(entry).toBeDefined();
      expect(entry?.request.method).toBe('POST');
      expect(entry?.request.url).toBe('https://api.example.com/data?foo=bar&baz=qux');
      expect(entry?.request.queryString).toEqual([
        { name: 'foo', value: 'bar' },
        { name: 'baz', value: 'qux' },
      ]);
      expect(entry?.request.postData).toEqual({
        mimeType: 'application/json',
        text: '{"key": "value"}',
      });
      expect(entry?.response.status).toBe(201);
      expect(entry?.response.statusText).toBe('Created');
      expect(entry?.response.redirectURL).toBe('/data/123');
      expect(entry?.response.content.mimeType).toBe('application/json');
      expect(entry?.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
