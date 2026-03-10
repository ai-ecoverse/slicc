/**
 * Minimal Chrome extension API type declarations.
 *
 * Only the subset used by slicc's extension mode. Uses interface-based
 * declaration because 'debugger' is a reserved word (can't be a namespace name).
 */

interface ChromeDebuggerTarget {
  tabId: number;
}

interface ChromeDebuggerAPI {
  attach(target: ChromeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerTarget): Promise<void>;
  sendCommand(
    target: ChromeDebuggerTarget,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  onEvent: {
    addListener(
      callback: (
        source: ChromeDebuggerTarget,
        method: string,
        params?: Record<string, unknown>,
      ) => void,
    ): void;
    removeListener(
      callback: (
        source: ChromeDebuggerTarget,
        method: string,
        params?: Record<string, unknown>,
      ) => void,
    ): void;
  };
  onDetach: {
    addListener(
      callback: (source: ChromeDebuggerTarget, reason: string) => void,
    ): void;
    removeListener(
      callback: (source: ChromeDebuggerTarget, reason: string) => void,
    ): void;
  };
}

interface ChromeTab {
  id: number;
  title?: string;
  url?: string;
}

interface ChromeMessageSender {
  id?: string;
  tab?: ChromeTab;
}

interface ChromeAPI {
  runtime: {
    /** Extension ID — truthy when running as a Chrome extension. */
    id: string | undefined;
    /** Get the full URL to an extension-bundled resource. */
    getURL(path: string): string;
    lastError: { message?: string } | undefined;
    sendMessage(message: unknown, callback?: (response: unknown) => void): void;
    onMessage: {
      addListener(
        callback: (
          message: any,
          sender: ChromeMessageSender,
          sendResponse: (response?: unknown) => void,
        ) => void | boolean,
      ): void;
      removeListener(
        callback: (
          message: any,
          sender: ChromeMessageSender,
          sendResponse: (response?: unknown) => void,
        ) => void | boolean,
      ): void;
    };
  };
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  windows: {
    create(options: {
      url?: string;
      type?: string;
      width?: number;
      height?: number;
      focused?: boolean;
    }): Promise<{ id?: number }>;
    remove(windowId: number): Promise<void>;
  };
  debugger: ChromeDebuggerAPI;
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    create(properties: { url?: string; active?: boolean }): Promise<{ id: number }>;
    remove(tabId: number): Promise<void>;
  };
}

declare const chrome: ChromeAPI;
