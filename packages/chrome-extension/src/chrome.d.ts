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
  id?: number;
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
  /** Origin of the connecting page. Populated for externally_connectable
   *  connections (always present), and for internal connections when the
   *  caller is a page. */
  origin?: string;
  /** Frame id within `tab`. `0` is the top-level frame. */
  frameId?: number;
}

/** Long-lived port from `chrome.runtime.connect` / `onConnect` /
 *  `onConnectExternal`. */
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

interface ChromeActionAPI {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  onClicked: {
    addListener(callback: (tab: ChromeTab) => void): void;
  };
}

interface ChromeSidePanelAPI {
  setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
  open(options: { windowId?: number; tabId?: number }): Promise<void>;
  /** Chrome 141+. */
  close?(options: { windowId?: number }): Promise<void>;
  /** Chrome 141+. */
  onOpened?: { addListener(cb: (info: { windowId: number }) => void): void };
  /** Chrome 142+. */
  onClosed?: { addListener(cb: (info: { windowId: number }) => void): void };
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
    /**
     * Long-lived port opened by an externally_connectable page. The Port's
     * `sender` carries the page's `tab` / `frameId` / `origin` for pinning.
     */
    onConnectExternal: {
      addListener(callback: (port: ChromeRuntimePort) => void): void;
    };
  };
  notifications: {
    create(
      notificationId: string,
      options: {
        type: 'basic' | 'image' | 'list' | 'progress';
        iconUrl: string;
        title: string;
        message: string;
      }
    ): Promise<string>;
    onClicked: {
      addListener(callback: (notificationId: string) => void): void;
    };
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
    getCurrent(): Promise<{ id: number }>;
  };
  identity: {
    launchWebAuthFlow(options: {
      url: string;
      interactive: boolean;
      /**
       * Non-interactive only (Chrome 113+). When `false`, the hidden web view
       * is NOT terminated the moment the authorization page loads — it keeps
       * following navigations (including JS-driven redirects) until the flow
       * reaches the redirect URL. Default `true`.
       */
      abortOnLoadForNonInteractive?: boolean;
      /** Non-interactive only: max total run time in ms. */
      timeoutMsForNonInteractive?: number;
    }): Promise<string | undefined>;
    getRedirectURL(path?: string): string;
  };
  action: ChromeActionAPI;
  sidePanel: ChromeSidePanelAPI;
  storage: {
    local: ChromeStorageArea;
    session: ChromeStorageArea;
  };
  debugger: ChromeDebuggerAPI;
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(properties: {
      url?: string;
      active?: boolean;
      pinned?: boolean;
    }): Promise<{ id: number; windowId?: number }>;
    update(
      tabId: number,
      properties: { active?: boolean; pinned?: boolean; url?: string }
    ): Promise<ChromeTab>;
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
  scripting: {
    executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      func?: (...args: never[]) => unknown;
      args?: unknown[];
      world?: 'ISOLATED' | 'MAIN';
      injectImmediately?: boolean;
    }): Promise<Array<{ result?: unknown }>>;
  };
}

declare const chrome: ChromeAPI;
