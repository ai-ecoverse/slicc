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
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  onEvent: {
    addListener(
      callback: (
        source: ChromeDebuggerTarget,
        method: string,
        params?: Record<string, unknown>
      ) => void
    ): void;
    removeListener(
      callback: (
        source: ChromeDebuggerTarget,
        method: string,
        params?: Record<string, unknown>
      ) => void
    ): void;
  };
  onDetach: {
    addListener(callback: (source: ChromeDebuggerTarget, reason: string) => void): void;
    removeListener(callback: (source: ChromeDebuggerTarget, reason: string) => void): void;
  };
}

interface ChromeTab {
  id: number;
  title?: string;
  url?: string;
  windowId?: number;
}

interface ChromeTabChangeInfo {
  status?: 'loading' | 'complete';
  title?: string;
  url?: string;
}

interface ChromeMessageSender {
  id?: string;
  tab?: ChromeTab;
  url?: string;
}

interface ChromeOffscreenAPI {
  createDocument(params: { url: string; reasons: string[]; justification: string }): Promise<void>;
  hasDocument(): Promise<boolean>;
}

interface ChromeActionAPI {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  onClicked: {
    addListener(callback: (tab: ChromeTab) => void): void;
  };
}

interface ChromeStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeAPI {
  runtime: {
    /** Extension ID — truthy when running as a Chrome extension. */
    id: string | undefined;
    /** Get the full URL to an extension-bundled resource. */
    getURL(path: string): string;
    lastError: { message?: string } | undefined;
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<void>;
    /** Open the manifest's options_ui page in a new tab (or popup). */
    openOptionsPage(): Promise<void>;
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
    connect(connectInfo: { name: string }): {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(callback: (message: unknown) => void): void };
      onDisconnect: { addListener(callback: () => void): void };
    };
    onConnect: {
      addListener(
        callback: (port: {
          name: string;
          postMessage(message: unknown): void;
          disconnect(): void;
          onMessage: { addListener(callback: (message: unknown) => void): void };
          onDisconnect: { addListener(callback: () => void): void };
        }) => void
      ): void;
    };
  };
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
    setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
    close(options: { tabId?: number; windowId?: number }): Promise<void>;
  };
  windows: {
    create(options: {
      url?: string;
      type?: string;
      width?: number;
      height?: number;
      focused?: boolean;
    }): Promise<{ id?: number }>;
    update(windowId: number, properties: { focused?: boolean }): Promise<{ id?: number }>;
    remove(windowId: number): Promise<void>;
    getAll(): Promise<Array<{ id: number }>>;
  };
  identity: {
    launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined>;
    getRedirectURL(path?: string): string;
  };
  action: ChromeActionAPI;
  offscreen: ChromeOffscreenAPI;
  storage: {
    local: ChromeStorageArea;
    session: ChromeStorageArea;
  };
  debugger: ChromeDebuggerAPI;
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(properties: { url?: string; active?: boolean }): Promise<{ id: number }>;
    update(tabId: number, properties: { active?: boolean }): Promise<ChromeTab>;
    remove(tabId: number): Promise<void>;
    group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
    onCreated: {
      addListener(callback: (tab: ChromeTab) => void): void;
    };
    onUpdated: {
      addListener(
        callback: (tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void
      ): void;
    };
    onRemoved: {
      addListener(
        callback: (
          tabId: number,
          removeInfo: { windowId: number; isWindowClosing: boolean }
        ) => void
      ): void;
    };
  };
  webRequest: {
    onHeadersReceived: {
      addListener(
        callback: (details: {
          url: string;
          tabId: number;
          type: string;
          frameId: number;
          responseHeaders?: Array<{ name: string; value?: string }>;
        }) => void,
        filter: { urls: string[]; types?: string[] },
        extraInfoSpec?: string[]
      ): void;
    };
  };
  tabGroups: {
    update(
      groupId: number,
      properties: {
        title?: string;
        color?:
          | 'grey'
          | 'blue'
          | 'red'
          | 'yellow'
          | 'green'
          | 'pink'
          | 'purple'
          | 'cyan'
          | 'orange';
        collapsed?: boolean;
      }
    ): Promise<void>;
  };
}

declare const chrome: ChromeAPI;
