type CdpPayload = { [key: string]: unknown };

type ChromeStorageItems = { [key: string]: unknown };

interface ChromeTabQueryInfo {
  url?: string | string[];
  active?: boolean;
  currentWindow?: boolean;
  lastFocusedWindow?: boolean;
}

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

  close?(options: { windowId?: number }): Promise<void>;

  onOpened?: { addListener(cb: (info: { windowId: number }) => void): void };

  onClosed?: { addListener(cb: (info: { windowId: number }) => void): void };
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

      abortOnLoadForNonInteractive?: boolean;

      timeoutMsForNonInteractive?: number;
    }): Promise<string | undefined>;
    getRedirectURL(path?: string): string;
  };
  action: ChromeActionAPI;
  sidePanel: ChromeSidePanelAPI;
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
  tabs: {
    query(queryInfo: ChromeTabQueryInfo): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(properties: {
      url?: string;
      active?: boolean;
      pinned?: boolean;
    }): Promise<{ id: number; windowId?: number }>;
    update(
      tabId: number,
      properties: { active?: boolean; pinned?: boolean; url?: string; autoDiscardable?: boolean }
    ): Promise<ChromeTab>;
    reload(tabId: number): Promise<void>;
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
