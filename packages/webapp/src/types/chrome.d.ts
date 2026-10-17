type CdpPayload = { [key: string]: unknown };

type ChromeStorageItems = { [key: string]: unknown };

interface ChromeDebuggerTarget {
  tabId: number;
}

interface ChromeDebuggerAPI {
  attach(target: ChromeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerTarget): Promise<void>;
  sendCommand(
    target: ChromeDebuggerTarget,
    method: string,
    params?: CdpPayload
  ): Promise<CdpPayload>;
  onEvent: {
    addListener(
      callback: (source: ChromeDebuggerTarget, method: string, params?: CdpPayload) => void
    ): void;
    removeListener(
      callback: (source: ChromeDebuggerTarget, method: string, params?: CdpPayload) => void
    ): void;
  };
  onDetach: {
    addListener(callback: (source: ChromeDebuggerTarget, reason: string) => void): void;
    removeListener(callback: (source: ChromeDebuggerTarget, reason: string) => void): void;
  };
}

interface ChromeTab {
  id?: number;
  title?: string;
  url?: string;
  windowId?: number;
  pinned?: boolean;

  discarded?: boolean;

  status?: 'unloaded' | 'loading' | 'complete';

  pendingUrl?: string;

  openerTabId?: number;
}

interface ChromeMessageSender {
  id?: string;
  tab?: ChromeTab;
  url?: string;

  origin?: string;

  frameId?: number;
}

interface ChromeRuntimePort {
  name: string;
  sender?: ChromeMessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: { addListener(callback: () => void): void };
}

interface ChromeStorageArea {
  get(keys?: string | string[] | ChromeStorageItems | null): Promise<ChromeStorageItems>;
  set(items: ChromeStorageItems): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeAPI {
  runtime: {
    id: string | undefined;

    getURL(path: string): string;
    lastError: { message?: string } | undefined;
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<void>;

    openOptionsPage(): Promise<void>;
    getContexts(filter: {
      contextTypes?: string[];
    }): Promise<Array<{ contextType: string; documentUrl?: string }>>;
    onInstalled: {
      addListener(callback: () => void): void;
    };
    onStartup: {
      addListener(callback: () => void): void;
    };
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: ChromeMessageSender,
          sendResponse: (response?: unknown) => void
        ) => void | boolean
      ): void;
      removeListener(
        callback: (
          message: unknown,
          sender: ChromeMessageSender,
          sendResponse: (response?: unknown) => void
        ) => void | boolean
      ): void;
    };
    connect(connectInfo: { name: string }): ChromeRuntimePort;
    onConnect: {
      addListener(callback: (port: ChromeRuntimePort) => void): void;
    };

    onConnectExternal: {
      addListener(callback: (port: ChromeRuntimePort) => void): void;
    };

    onMessageExternal?: {
      addListener(
        callback: (
          message: unknown,
          sender: ChromeMessageSender,
          sendResponse: (response?: unknown) => void
        ) => void | boolean
      ): void;
    };

    onUpdateAvailable: {
      addListener(callback: (details: { version: string }) => void): void;
    };

    reload(): void;
  };
  windows: {
    create(options: {
      url?: string | string[];
      type?: 'normal' | 'popup' | 'panel' | string;
      width?: number;
      height?: number;
      left?: number;
      top?: number;
      focused?: boolean;
      state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen' | string;
    }): Promise<{
      id?: number;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      state?: string;
      tabs?: Array<{ id?: number }>;
    }>;
    update(
      windowId: number,
      properties: {
        focused?: boolean;
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen' | string;
      }
    ): Promise<{
      id?: number;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      state?: string;
    }>;
    get(
      windowId: number,
      queryOptions?: { populate?: boolean }
    ): Promise<{
      id?: number;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      state?: string;
      tabs?: Array<{ id?: number }>;
    }>;
    remove(windowId: number): Promise<void>;
    getAll(): Promise<Array<{ id: number }>>;
    getCurrent(): Promise<{ id: number }>;
  };
  identity: {
    launchWebAuthFlow(options: {
      url: string;
      interactive: boolean;

      abortOnLoadForNonInteractive?: boolean;

      timeoutMsForNonInteractive?: number;
    }): Promise<string | undefined>;
    getRedirectURL(path?: string): string;
  };
  storage: {
    local: ChromeStorageArea;
    session: ChromeStorageArea;

    onChanged?: {
      addListener(
        callback: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          areaName: string
        ) => void
      ): void;
    };
  };
  debugger: ChromeDebuggerAPI;
  webRequest: {
    onHeadersReceived: {
      addListener(
        callback: (details: {
          url: string;
          tabId: number;
          type: string;
          frameId: number;
          statusCode: number;
          statusLine?: string;
          responseHeaders?: Array<{ name: string; value?: string }>;
        }) => void,
        filter: { urls: string[]; types?: string[]; tabId?: number },
        extraInfoSpec?: string[]
      ): void;
    };
  };
}

declare const chrome: ChromeAPI;
