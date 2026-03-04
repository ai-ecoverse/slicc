/**
 * DebuggerClient — CDPTransport implementation using chrome.debugger API.
 *
 * Used in Chrome extension mode. Translates CDP commands into chrome.debugger
 * API calls and maps Target.* commands to chrome.tabs/chrome.debugger.
 */

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';
import type { CDPTransport } from './transport.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cdp:debugger');

// Chrome extension API types provided by src/extension/chrome.d.ts

export class DebuggerClient implements CDPTransport {
  private _state: ConnectionState = 'disconnected';
  private listeners = new Map<string, Set<CDPEventListener>>();
  /** Maps synthetic sessionId → Chrome tab ID. */
  private sessionToTab = new Map<string, number>();
  /** Tracks which tab IDs we've attached the debugger to. */
  private attachedTabs = new Set<number>();

  private onEventHandler = (
    source: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): void => {
    if (!this.attachedTabs.has(source.tabId)) return;
    log.debug('Event', { tabId: source.tabId, method });
    const set = this.listeners.get(method);
    if (set) {
      for (const listener of set) {
        try {
          listener(params ?? {});
        } catch {
          // Don't let one listener break others
        }
      }
    }
  };

  private onDetachHandler = (
    source: { tabId: number },
    reason: string,
  ): void => {
    log.warn('Debugger detached', { tabId: source.tabId, reason });
    this.attachedTabs.delete(source.tabId);
    // Remove session mappings for this tab
    for (const [sessionId, tabId] of this.sessionToTab) {
      if (tabId === source.tabId) {
        this.sessionToTab.delete(sessionId);
      }
    }
    if (this.attachedTabs.size === 0) {
      this._state = 'disconnected';
    }
  };

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Connect — no-op for extension mode. Sets state to connected and registers
   * chrome.debugger event listeners.
   */
  async connect(_options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    chrome.debugger.onEvent.addListener(this.onEventHandler);
    chrome.debugger.onDetach.addListener(this.onDetachHandler);
    this._state = 'connected';
    log.info('DebuggerClient connected (extension mode)');
  }

  /**
   * Disconnect — detach from all tabs and clean up listeners.
   */
  disconnect(): void {
    for (const tabId of this.attachedTabs) {
      chrome.debugger.detach({ tabId }).catch(() => {
        // Tab may already be closed
      });
    }
    chrome.debugger.onEvent.removeListener(this.onEventHandler);
    chrome.debugger.onDetach.removeListener(this.onDetachHandler);
    this.attachedTabs.clear();
    this.sessionToTab.clear();
    this._state = 'disconnected';
    log.info('DebuggerClient disconnected');
  }

  /**
   * Send a CDP command. Intercepts Target.* commands and maps them to
   * chrome extension APIs. All other commands pass through to chrome.debugger.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    _timeout?: number,
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') {
      throw new Error('DebuggerClient is not connected');
    }

    // Route Target.* commands to extension APIs
    switch (method) {
      case 'Target.getTargets':
        return this.handleGetTargets();

      case 'Target.attachToTarget':
        return this.handleAttachToTarget(params!);

      case 'Target.detachFromTarget':
        return this.handleDetachFromTarget(params!);

      case 'Target.createTarget':
        return this.handleCreateTarget(params!);

      default:
        return this.sendCdpCommand(method, params, sessionId);
    }
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  once(event: string, timeout = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for event: ${event}`));
      }, timeout);

      const handler: CDPEventListener = (params) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  // -------------------------------------------------------------------------
  // Target.* command handlers
  // -------------------------------------------------------------------------

  private async handleGetTargets(): Promise<Record<string, unknown>> {
    const tabs = await chrome.tabs.query({});
    const targetInfos = tabs.map((tab) => ({
      targetId: String(tab.id),
      type: 'page',
      title: tab.title ?? '',
      url: tab.url ?? '',
      attached: this.attachedTabs.has(tab.id!),
    }));
    return { targetInfos };
  }

  private async handleAttachToTarget(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const targetId = params['targetId'] as string;
    const tabId = parseInt(targetId, 10);

    if (!this.attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.attachedTabs.add(tabId);
    }

    // Use targetId as sessionId (1:1 mapping in extension mode)
    const sessionId = targetId;
    this.sessionToTab.set(sessionId, tabId);
    return { sessionId };
  }

  private async handleDetachFromTarget(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = params['sessionId'] as string;
    const tabId = this.sessionToTab.get(sessionId);

    if (tabId !== undefined) {
      this.sessionToTab.delete(sessionId);
      // Only actually detach if no other sessions reference this tab
      const stillReferenced = [...this.sessionToTab.values()].includes(tabId);
      if (!stillReferenced) {
        this.attachedTabs.delete(tabId);
        await chrome.debugger.detach({ tabId }).catch(() => {
          // Tab may already be closed
        });
      }
    }

    return {};
  }

  private async handleCreateTarget(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = (params['url'] as string) ?? 'about:blank';
    const tab = await chrome.tabs.create({ url, active: false });
    return { targetId: String(tab.id) };
  }

  // -------------------------------------------------------------------------
  // Pass-through CDP commands
  // -------------------------------------------------------------------------

  private async sendCdpCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const tabId = sessionId ? this.sessionToTab.get(sessionId) : undefined;
    if (tabId === undefined) {
      throw new Error(
        `No tab attached for sessionId: ${sessionId ?? '(none)'}. ` +
        'Attach to a target first.',
      );
    }

    log.debug('Send', { method, tabId, sessionId });
    const result = await chrome.debugger.sendCommand(
      { tabId },
      method,
      params,
    );
    return result ?? {};
  }
}
