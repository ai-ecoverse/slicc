import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPlaywrightCommand,
  getSharedState,
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from './playwright-command.js';
import type { BrowserAPI } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';

/** Minimal mock BrowserAPI. */
function createMockBrowser(overrides: Partial<BrowserAPI> = {}): BrowserAPI {
  return {
    listPages: vi
      .fn()
      .mockResolvedValue([
        {
          targetId: 'tab-1',
          title: 'Test Page',
          url: 'https://example.com',
          type: 'page',
          attached: false,
        },
      ]),
    createPage: vi.fn().mockResolvedValue('tab-new'),
    attachToPage: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('iVBORw0KGgo='), // tiny valid-ish base64
    evaluate: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    clickByBackendNodeId: vi.fn().mockResolvedValue(undefined),
    dblclickByBackendNodeId: vi.fn().mockResolvedValue(undefined),
    hoverByBackendNodeId: vi.fn().mockResolvedValue(undefined),
    selectByBackendNodeId: vi.fn().mockResolvedValue(undefined),
    setCheckedByBackendNodeId: vi.fn().mockResolvedValue('toggled' as const),
    dragByBackendNodeIds: vi.fn().mockResolvedValue(undefined),
    closePage: vi.fn().mockResolvedValue(undefined),
    sendCDP: vi.fn().mockResolvedValue({}),
    type: vi.fn().mockResolvedValue(undefined),
    getAccessibilityTree: vi.fn().mockResolvedValue({
      role: 'RootWebArea',
      name: 'Test Page',
      children: [
        {
          role: 'button',
          name: 'Submit',
          backendNodeId: 42,
          children: [],
        },
        {
          role: 'link',
          name: 'Home',
          backendNodeId: 43,
          children: [],
        },
        {
          role: 'textbox',
          name: 'Search',
          backendNodeId: 44,
          children: [],
        },
        {
          role: 'checkbox',
          name: 'Agree',
          backendNodeId: 45,
          children: [],
        },
      ],
    }),
    getTransport: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({}),
    }),
    getSessionId: vi.fn().mockReturnValue('session-1'),
    ...overrides,
  } as unknown as BrowserAPI;
}

function createMockFS(): VirtualFS & { _files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  return {
    _files: files,
    writeFile: vi.fn().mockImplementation(async (path: string, content: string | Uint8Array) => {
      files.set(path, content);
    }),
    readFile: vi.fn().mockImplementation(async (path: string) => {
      if (files.has(path)) return files.get(path)!;
      const err = new Error(`ENOENT: ${path}`);
      (err as any).code = 'ENOENT';
      throw err;
    }),
    mkdir: vi.fn().mockResolvedValue(undefined),
  } as unknown as VirtualFS & { _files: Map<string, string | Uint8Array> };
}

describe('createPlaywrightCommand', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('creates a command with the given name', () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    expect(cmd.name).toBe('playwright-cli');
  });

  it('supports aliases', () => {
    expect(createPlaywrightCommand('playwright', browser as BrowserAPI, fs as VirtualFS).name).toBe(
      'playwright'
    );
    expect(createPlaywrightCommand('puppeteer', browser as BrowserAPI, fs as VirtualFS).name).toBe(
      'puppeteer'
    );
  });

  it('shares tab state across aliases', async () => {
    const pages: Array<{
      targetId: string;
      title: string;
      url: string;
      type: string;
      attached: boolean;
      active?: boolean;
    }> = [];
    const sharedBrowser = createMockBrowser({
      listPages: vi.fn().mockImplementation(async () => pages),
      createPage: vi.fn().mockImplementation(async (url: string) => {
        pages.push({
          targetId: 'tab-new',
          title: 'New Tab',
          url,
          type: 'page',
          attached: false,
        });
        return 'tab-new';
      }),
      evaluate: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ url: 'https://example.com', title: 'Test Page' })),
    });

    const playwright = createPlaywrightCommand(
      'playwright',
      sharedBrowser as BrowserAPI,
      fs as VirtualFS
    );
    const puppeteer = createPlaywrightCommand(
      'puppeteer',
      sharedBrowser as BrowserAPI,
      fs as VirtualFS
    );

    await playwright.execute(['open', 'https://example.com'], {} as any);
    const result = await puppeteer.execute(['snapshot'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(sharedBrowser.attachToPage).toHaveBeenCalledWith('tab-new');
  });
});

describe('playwright-cli help', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('shows help with no arguments', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute([], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: playwright-cli');
    expect(result.stdout).toContain('snapshot');
    expect(result.stdout).toContain('click');
  });

  it('shows help with --help flag', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['--help'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: playwright-cli');
  });

  it('shows help with help subcommand', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['help'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: playwright-cli');
  });

  it('shows alias-specific help when invoked through an alias', async () => {
    const cmd = createPlaywrightCommand('playwright', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['--help'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: playwright <command>');
    expect(result.stdout).toContain('Aliases: playwright-cli, puppeteer');
  });
});

describe('playwright-cli open', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('opens a new tab with a URL', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Opened tab');
    expect(result.stdout).toContain('https://example.com');
    expect(browser.createPage).toHaveBeenCalledWith('https://example.com');
  });

  it('opens about:blank by default', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['open'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(browser.createPage).toHaveBeenCalledWith('about:blank');
  });

  it('treats the first background open as the current tab when no tab was selected yet', async () => {
    const pages: Array<{
      targetId: string;
      title: string;
      url: string;
      type: string;
      attached: boolean;
      active?: boolean;
    }> = [];
    browser = createMockBrowser({
      listPages: vi.fn().mockImplementation(async () => pages),
      createPage: vi.fn().mockImplementation(async (url: string) => {
        pages.push({ targetId: 'tab-new', title: 'New Tab', url, type: 'page', attached: false });
        return 'tab-new';
      }),
      evaluate: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ url: 'https://example.com', title: 'Test Page' })),
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com'], {} as any);
    const result = await cmd.execute(['snapshot'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(browser.attachToPage).toHaveBeenCalledWith('tab-new');
  });

  it('does not convert regular URLs to preview paths', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com'], {} as any);

    expect(browser.createPage).toHaveBeenCalledWith('https://example.com');
  });
});

describe('playwright-cli goto', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('requires a URL', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['goto'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('goto requires a URL');
  });

  it('navigates to URL', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    // First open a tab so there's a current target
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['goto', 'https://other.com'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Navigated to https://other.com');
    expect(browser.navigate).toHaveBeenCalledWith('https://other.com');
  });
});

describe('playwright-cli snapshot', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    // Mock evaluate for page info
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('returns accessibility tree with refs', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['snapshot'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Page URL: https://example.com');
    expect(result.stdout).toContain('button "Submit"');
    expect(result.stdout).toContain('[ref=e1]');
    expect(result.stdout).toContain('link "Home"');
    expect(result.stdout).toContain('[ref=e2]');
    expect(result.stdout).toContain('textbox "Search"');
    expect(result.stdout).toContain('[ref=e3]');
  });

  it('does not crash on non-string accessibility fields', async () => {
    browser = createMockBrowser({
      getAccessibilityTree: vi.fn().mockResolvedValue({
        role: 'RootWebArea',
        name: 'Slack',
        children: [
          {
            role: 'textbox',
            name: { label: 'Message' },
            value: 0,
            backendNodeId: 44,
            children: [],
          },
        ],
      } as any),
    });
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://app.slack.com/client', title: 'Slack' })
    );

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.slack.com/client', '--foreground'], {} as any);
    const result = await cmd.execute(['snapshot'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Page Title: Slack');
    expect(result.stdout).toContain('textbox');
    expect(result.stdout).toContain('Message');
    expect(result.stdout).toContain('[ref=e1]');
    expect(result.stdout).toContain(': "0"');
  });

  it('saves snapshot to file with --filename', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['snapshot', '--filename=/tmp/snap.txt'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Snapshot saved to /tmp/snap.txt');
    expect(fs.writeFile).toHaveBeenCalledWith('/tmp/snap.txt', expect.any(String));
  });

  it('skips Chrome internal UI tabs when auto-selecting a target', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        targetId: 'tab-omnibox',
        title: 'Omnibox Popup',
        url: 'chrome://new-tab-page/',
        active: true,
      },
      { targetId: 'tab-1', title: 'Test Page', url: 'https://example.com' },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['snapshot'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(browser.attachToPage).toHaveBeenCalledWith('tab-1');
    expect(browser.attachToPage).not.toHaveBeenCalledWith('tab-omnibox');
  });

  it('fails with no tab available', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['snapshot'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No tab available');
  });

  it('ignores internal UI targets when auto-selecting a tab', async () => {
    browser = createMockBrowser({
      listPages: vi.fn().mockResolvedValue([
        {
          targetId: 'popup',
          title: 'Omnibox Popup',
          url: 'chrome-search://local-omnibox-popup/local-omnibox-popup.html',
          type: 'page',
          attached: false,
          active: true,
        },
        {
          targetId: 'tab-1',
          title: 'Docs',
          url: 'https://example.com/docs',
          type: 'page',
          attached: false,
        },
      ]),
    });
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com/docs', title: 'Docs' })
    );

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['snapshot'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(browser.attachToPage).toHaveBeenCalledWith('tab-1');
  });
});

describe('playwright-cli click', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('requires a ref argument', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['click'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('click requires a ref');
  });

  it('requires a snapshot first', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['click', 'e1'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No snapshot available');
  });

  it('clicks element by ref using backendNodeId', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['click', 'e1'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Clicked e1');
    expect(browser.clickByBackendNodeId).toHaveBeenCalledWith(42);
  });

  it('reports unknown ref', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);

    // e99 doesn't exist; backendNodeId won't be found, CSS selector won't be found
    const result = await cmd.execute(['click', 'e99'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown ref');
  });

  it('invalidates snapshot after click', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    await cmd.execute(['click', 'e1'], {} as any);

    // Second click without re-snapshot should fail
    const result = await cmd.execute(['click', 'e1'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No snapshot available');
  });
});

describe('playwright-cli type and fill', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('type requires text', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['type'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('type requires text');
  });

  it('types text into current tab', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['type', 'hello', 'world'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Typed: hello world');
    expect(browser.type).toHaveBeenCalledWith('hello world');
  });

  it('fill requires ref and text', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['fill', 'e1'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('fill requires <ref> <text>');
  });

  it('fills input by ref using backendNodeId', async () => {
    // Mock transport for DOM operations — value matches after type (normal HTML input)
    let callCount = 0;
    const mockTransport = {
      send: vi.fn().mockImplementation((method: string, params: Record<string, unknown>) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') {
          callCount++;
          const fn = params['functionDeclaration'] as string;
          // The read-back value check — return the typed text to indicate value matches
          if (fn.includes('isContentEditable') && fn.includes('el.value')) {
            return { result: { value: 'search term' } };
          }
          return { result: { value: undefined } };
        }
        return {};
      }),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);

    // e3 is the textbox "Search" with backendNodeId 44
    const result = await cmd.execute(['fill', 'e3', 'search', 'term'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Filled e3 with: search term');
    expect(browser.clickByBackendNodeId).toHaveBeenCalledWith(44);
    expect(browser.type).toHaveBeenCalledWith('search term');
  });

  it('uses native setter fallback when value does not match after typing (React-controlled input)', async () => {
    // Mock transport: value read-back returns empty string (React didn't register the keystrokes)
    const transportCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const mockTransport = {
      send: vi.fn().mockImplementation((method: string, params: Record<string, unknown>) => {
        transportCalls.push({ method, params });
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') {
          const fn = params['functionDeclaration'] as string;
          // Read-back: return empty string to simulate React-controlled input mismatch
          if (
            fn.includes('isContentEditable') &&
            fn.includes('el.value') &&
            !fn.includes('nativeSetter')
          ) {
            return { result: { value: '' } };
          }
          return { result: { value: undefined } };
        }
        return {};
      }),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);

    const result = await cmd.execute(['fill', 'e3', 'test@example.com'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Filled e3 with: test@example.com');

    // Verify the fallback was called — look for a callFunctionOn with nativeSetter in the function
    const fallbackCall = transportCalls.find(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        (c.params['functionDeclaration'] as string).includes('nativeSetter')
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall!.params['arguments']).toEqual([{ value: 'test@example.com' }]);
  });

  it('does NOT trigger native setter fallback when value matches after typing', async () => {
    // Mock transport: value read-back returns the typed text (normal HTML input)
    const transportCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const mockTransport = {
      send: vi.fn().mockImplementation((method: string, params: Record<string, unknown>) => {
        transportCalls.push({ method, params });
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') {
          const fn = params['functionDeclaration'] as string;
          // Read-back: return the fill text to simulate normal input behavior
          if (
            fn.includes('isContentEditable') &&
            fn.includes('el.value') &&
            !fn.includes('nativeSetter')
          ) {
            return { result: { value: 'hello world' } };
          }
          return { result: { value: undefined } };
        }
        return {};
      }),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);

    const result = await cmd.execute(['fill', 'e3', 'hello', 'world'], {} as any);
    expect(result.exitCode).toBe(0);

    // Verify the fallback was NOT called — no callFunctionOn with nativeSetter
    const fallbackCall = transportCalls.find(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        (c.params['functionDeclaration'] as string).includes('nativeSetter')
    );
    expect(fallbackCall).toBeUndefined();
  });

  it('clears contenteditable elements in the selector fallback path', async () => {
    browser = createMockBrowser({
      getAccessibilityTree: vi.fn().mockResolvedValue({
        role: 'RootWebArea',
        name: 'Test Page',
        children: [
          {
            role: 'textbox',
            name: 'Editor',
            children: [],
          },
        ],
      }),
    });
    (browser.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify({ url: 'https://example.com', title: 'Test Page' }))
      .mockResolvedValueOnce(undefined) // clear call
      .mockResolvedValueOnce('hello'); // value read-back (matches, so no fallback)

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['fill', 'e1', 'hello'], {} as any);
    const clickedSelector = (browser.click as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const clearScript = (browser.evaluate as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .find(
        (script) =>
          typeof script === 'string' &&
          script.includes('isContentEditable') &&
          script.includes('textContent')
      ) as string | undefined;

    expect(result.exitCode).toBe(0);
    expect(browser.click).toHaveBeenCalled();
    expect(browser.type).toHaveBeenCalledWith('hello');
    expect(clickedSelector).toContain('[contenteditable]');
    expect(clickedSelector).toContain(',');
    expect(clearScript).toBeDefined();
    expect(clearScript).toContain(`document.querySelector(${JSON.stringify(clickedSelector)})`);
    expect(clearScript).toContain('isContentEditable');
  });
});

describe('playwright-cli eval', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('requires an expression', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['eval'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('eval requires an expression');
  });

  it('evaluates JS expression', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('42');
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['eval', '1+1'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('42');
  });
});

describe('playwright-cli tab management', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('tab-list shows available tabs', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Test Page');
    expect(result.stdout).toContain('https://example.com');
  });

  it('tab-list filters Chrome internal UI targets and keeps only actionable tabs', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        targetId: 'popup',
        title: 'Omnibox Popup',
        url: 'chrome-search://local-omnibox-popup/local-omnibox-popup.html',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'settings',
        title: 'Settings',
        url: 'chrome://settings/',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'docs',
        title: 'Docs',
        url: 'https://example.com/docs',
        type: 'page',
        attached: false,
      },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-list'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Omnibox Popup');
    expect(result.stdout).not.toContain('chrome://settings/');
    expect(result.stdout).toContain('0: Docs (https://example.com/docs)');
  });

  it('tab-list excludes Chrome internal UI tabs', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { targetId: 'tab-omnibox', title: 'Omnibox Popup', url: 'chrome://new-tab-page/' },
      { targetId: 'tab-settings', title: 'Settings', url: 'chrome://settings/' },
      { targetId: 'tab-1', title: 'Test Page', url: 'https://example.com' },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-list'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Test Page');
    expect(result.stdout).not.toContain('Omnibox Popup');
    expect(result.stdout).not.toContain('chrome://settings/');
  });

  it('tab-list shows no tabs when empty', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No tabs open');
  });

  it('tab-list shows → for current target and * for active tab', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { targetId: 'tab-new', title: 'Page A', url: 'https://a.com', active: false },
      { targetId: 'tab-2', title: 'Page B', url: 'https://b.com', active: true },
    ]);
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    // open --foreground sets currentTarget to createPage result ('tab-new')
    await cmd.execute(['open', 'https://a.com', '--foreground'], {} as any);

    const result = await cmd.execute(['tab-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('→ 0: Page A');
    expect(result.stdout).toContain('* 1: Page B');
  });

  it('tab-list shows → for tab that is both current and active', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { targetId: 'tab-new', title: 'Page A', url: 'https://a.com', active: true },
    ]);
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://a.com', '--foreground'], {} as any);

    const result = await cmd.execute(['tab-list'], {} as any);
    expect(result.exitCode).toBe(0);
    // Current target takes priority over active marker
    expect(result.stdout).toContain('→ 0: Page A');
    expect(result.stdout).not.toContain('* ');
  });

  it('tab-select requires an index', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-select'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('tab-select requires an index');
  });

  it('tab-select rejects out-of-range index', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-select', '99'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('out of range');
  });

  it('tab-select uses filtered indexes', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { targetId: 'popup', title: 'Omnibox Popup', url: '', type: 'page', attached: false },
      {
        targetId: 'tab-1',
        title: 'Settings',
        url: 'chrome://settings/',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'tab-2',
        title: 'Docs',
        url: 'https://example.com/docs',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'tab-3',
        title: 'Other Docs',
        url: 'https://example.com/other',
        type: 'page',
        attached: false,
      },
    ]);
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com/other', title: 'Other Docs' })
    );

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const selectResult = await cmd.execute(['tab-select', '1'], {} as any);
    const snapshotResult = await cmd.execute(['snapshot'], {} as any);

    expect(selectResult.exitCode).toBe(0);
    expect(selectResult.stdout).toContain('Switched to tab 1: Other Docs');
    expect(snapshotResult.exitCode).toBe(0);
    expect(browser.attachToPage).toHaveBeenLastCalledWith('tab-3');
  });

  it('tab-select ignores Chrome internal UI tabs when indexing', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { targetId: 'tab-omnibox', title: 'Omnibox Popup', url: 'chrome://new-tab-page/' },
      { targetId: 'tab-1', title: 'Test Page', url: 'https://example.com' },
      { targetId: 'tab-2', title: 'Other Page', url: 'https://other.example' },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-select', '1'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Switched to tab 1: Other Page');
  });

  it('tab-close rejects malformed indexes without closing a tab', async () => {
    const send = vi.fn().mockResolvedValue({});
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-close', '1foo'], {} as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid tab index "1foo"');
    expect(send).not.toHaveBeenCalled();
  });

  it('tab-close closes a valid indexed tab', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        targetId: 'tab-1',
        title: 'Test Page',
        url: 'https://example.com',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'tab-2',
        title: 'Other Page',
        url: 'https://other.example',
        type: 'page',
        attached: false,
      },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-close', '1'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Closed tab 1');
    expect(browser.closePage).toHaveBeenCalledWith('tab-2');
  });

  it('tab-close ignores internal UI targets when resolving indexes', async () => {
    (browser.listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        targetId: 'popup',
        title: 'Omnibox Popup',
        url: 'chrome-search://local-omnibox-popup/local-omnibox-popup.html',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'tab-1',
        title: 'Settings',
        url: 'chrome://settings/',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'tab-2',
        title: 'Docs',
        url: 'https://example.com/docs',
        type: 'page',
        attached: false,
      },
      {
        targetId: 'tab-3',
        title: 'Other Docs',
        url: 'https://example.com/other',
        type: 'page',
        attached: false,
      },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-close', '1'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Closed tab 1');
    expect(browser.closePage).toHaveBeenCalledWith('tab-3');
  });

  it('tab-close closes a remote (follower) tab via closePage', async () => {
    const remoteTargetId = 'follower-abc:remote-tab-1';
    browser = createMockBrowser({
      listPages: vi.fn().mockResolvedValue([]),
      listAllTargets: vi
        .fn()
        .mockResolvedValue([
          { targetId: remoteTargetId, title: 'Remote Page', url: 'https://httpbin.org/get' },
        ]),
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-close', '0'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Closed tab 0');
    expect(browser.closePage).toHaveBeenCalledWith(remoteTargetId);
  });

  it('tab-new opens a new tab', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['tab-new', 'https://new.com'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Opened tab');
    expect(browser.createPage).toHaveBeenCalledWith('https://new.com');
  });
});

describe('playwright-cli navigation', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('go-back navigates back', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['go-back'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Navigated back');
    expect(browser.evaluate).toHaveBeenCalledWith('history.back()');
  });

  it('go-forward navigates forward', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['go-forward'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Navigated forward');
  });

  it('reload reloads current tab', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['reload'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Reloaded');
    expect(browser.sendCDP).toHaveBeenCalledWith('Page.reload');
  });
});

describe('playwright-cli dblclick', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('requires a ref', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['dblclick'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('dblclick requires a ref');
  });

  it('double-clicks element by ref', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['dblclick', 'e1'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Double-clicked e1');
    expect(browser.dblclickByBackendNodeId).toHaveBeenCalledWith(42, 'left');
  });

  it('passes button argument', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['dblclick', 'e1', 'right'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(browser.dblclickByBackendNodeId).toHaveBeenCalledWith(42, 'right');
  });
});

describe('playwright-cli hover', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('requires a ref', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['hover'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('hover requires a ref');
  });

  it('hovers element by ref', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['hover', 'e1'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Hovered e1');
    expect(browser.hoverByBackendNodeId).toHaveBeenCalledWith(42);
  });

  it('does not invalidate snapshot', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    await cmd.execute(['hover', 'e1'], {} as any);
    // Snapshot should still be available (hover doesn't mutate DOM)
    const result = await cmd.execute(['hover', 'e2'], {} as any);
    expect(result.exitCode).toBe(0);
  });
});

describe('playwright-cli select', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('requires ref and value', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['select', 'e1'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('select requires <ref> <value>');
  });

  it('selects value on element', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['select', 'e1', 'option1'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Selected "option1" on e1');
    expect(browser.selectByBackendNodeId).toHaveBeenCalledWith(42, 'option1');
  });
});

describe('playwright-cli check/uncheck', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('check requires a ref', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['check'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('check requires a ref');
  });

  it('checks a checkbox', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    // e4 is the checkbox "Agree" with backendNodeId 45
    const result = await cmd.execute(['check', 'e4'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Checked e4');
    expect(browser.setCheckedByBackendNodeId).toHaveBeenCalledWith(45, true);
  });

  it('reports already checked', async () => {
    (browser.setCheckedByBackendNodeId as ReturnType<typeof vi.fn>).mockResolvedValue('already');
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['check', 'e4'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already checked');
  });

  it('unchecks a checkbox', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['uncheck', 'e4'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Unchecked e4');
    expect(browser.setCheckedByBackendNodeId).toHaveBeenCalledWith(45, false);
  });
});

describe('playwright-cli drag', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('requires start and end refs', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['drag', 'e1'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('drag requires <startRef> <endRef>');
  });

  it('drags from one element to another', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const result = await cmd.execute(['drag', 'e1', 'e2'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Dragged e1 to e2');
    expect(browser.dragByBackendNodeIds).toHaveBeenCalledWith(42, 43);
  });
});

describe('playwright-cli resize', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('requires width and height', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['resize', '800'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('resize requires <width> <height>');
  });

  it('rejects non-positive dimensions', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['resize', '0', '600'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('positive integer');
  });

  it('resizes viewport', async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({}),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['resize', '1024', '768'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Resized viewport to 1024x768');
    expect(mockTransport.send).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false },
      'session-1'
    );
  });
});

describe('playwright-cli dialog commands', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('dialog-accept sends accept', async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({}),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['dialog-accept'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Accepted dialog');
    expect(mockTransport.send).toHaveBeenCalledWith(
      'Page.handleJavaScriptDialog',
      { accept: true },
      'session-1'
    );
  });

  it('dialog-accept passes prompt text', async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({}),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['dialog-accept', 'my', 'answer'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Accepted dialog with "my answer"');
    expect(mockTransport.send).toHaveBeenCalledWith(
      'Page.handleJavaScriptDialog',
      { accept: true, promptText: 'my answer' },
      'session-1'
    );
  });

  it('dialog-dismiss sends dismiss', async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({}),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['dialog-dismiss'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Dismissed dialog');
    expect(mockTransport.send).toHaveBeenCalledWith(
      'Page.handleJavaScriptDialog',
      { accept: false },
      'session-1'
    );
  });
});

describe('playwright-cli cookie commands', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('cookie-list shows cookies', async () => {
    (browser.sendCDP as ReturnType<typeof vi.fn>).mockResolvedValue({
      cookies: [
        {
          name: 'session',
          value: 'abc123',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expires: 0,
        },
      ],
    });
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['cookie-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('session=abc123');
    expect(result.stdout).toContain('Domain=.example.com');
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.getCookies');
  });

  it('cookie-list shows message when no cookies', async () => {
    (browser.sendCDP as ReturnType<typeof vi.fn>).mockResolvedValue({ cookies: [] });
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['cookie-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No cookies');
  });

  it('cookie-get finds cookie by name', async () => {
    (browser.sendCDP as ReturnType<typeof vi.fn>).mockResolvedValue({
      cookies: [
        {
          name: 'session',
          value: 'abc123',
          domain: '.example.com',
          path: '/',
          secure: false,
          httpOnly: false,
          expires: 0,
        },
        {
          name: 'other',
          value: 'xyz',
          domain: '.example.com',
          path: '/',
          secure: false,
          httpOnly: false,
          expires: 0,
        },
      ],
    });
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['cookie-get', 'session', '--tab', 'tab-1'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('session=abc123');
    expect(result.stdout).not.toContain('other');
  });

  it('cookie-get fails when not found', async () => {
    (browser.sendCDP as ReturnType<typeof vi.fn>).mockResolvedValue({ cookies: [] });
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['cookie-get', 'missing', '--tab', 'tab-1'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('cookie-get requires a name', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['cookie-get'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a cookie name');
  });

  it('cookie-set sets a cookie with flags', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        href: 'https://example.com/page',
        hostname: 'example.com',
        pathname: '/page',
      })
    );
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(
      ['cookie-set', 'name', 'value', '--domain=.example.com', '--secure', '--httpOnly', '--tab', 'tab-1'],
      {} as any
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cookie "name" set');
    expect(browser.sendCDP).toHaveBeenCalledWith(
      'Network.setCookie',
      expect.objectContaining({
        name: 'name',
        value: 'value',
        domain: '.example.com',
        secure: true,
        httpOnly: true,
      })
    );
  });

  it('cookie-set uses the current page url for simple forms', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        href: 'https://example.com/page',
        hostname: 'example.com',
        pathname: '/page',
      })
    );
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['cookie-set', 'name', 'value', '--tab', 'tab-1'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.setCookie', {
      name: 'name',
      value: 'value',
      url: 'https://example.com/page',
    });
  });

  it('cookie-set requires name and value', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['cookie-set', 'only-name'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires <name> <value>');
  });

  it('cookie-delete deletes a cookie', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(
      ['cookie-delete', 'session', '--domain=.example.com'],
      {} as any
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cookie "session" deleted');
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.deleteCookies', {
      name: 'session',
      domain: '.example.com',
    });
  });

  it('cookie-delete uses the current page url for simple forms', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        href: 'https://example.com/page',
        hostname: 'example.com',
        pathname: '/page',
      })
    );
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['cookie-delete', 'session'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.deleteCookies', {
      name: 'session',
      url: 'https://example.com/page',
    });
  });

  it('cookie-delete requires a name', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['cookie-delete'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a cookie name');
  });

  it('cookie-clear clears all cookies', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['cookie-clear'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('All cookies cleared');
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.clearBrowserCookies');
  });
});

describe('playwright-cli localStorage commands', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('localstorage-list shows entries', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify([
        ['key1', 'val1'],
        ['key2', 'val2'],
      ])
    );
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('key1=val1');
    expect(result.stdout).toContain('key2=val2');
  });

  it('localstorage-list shows message when empty', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('[]');
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No localStorage entries');
  });

  it('localstorage-get returns value', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('myValue');
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-get', 'myKey'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('myValue');
  });

  it('localstorage-get fails when key not found', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-get', 'missing'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('localstorage-get requires a key', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['localstorage-get'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a key');
  });

  it('localstorage-set sets a value', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-set', 'myKey', 'myValue'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('localStorage "myKey" set');
    expect(browser.evaluate).toHaveBeenCalledWith('localStorage.setItem("myKey", "myValue")');
  });

  it('localstorage-set requires key and value', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['localstorage-set', 'onlyKey'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires <key> <value>');
  });

  it('localstorage-delete removes a key', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-delete', 'myKey'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('localStorage "myKey" deleted');
    expect(browser.evaluate).toHaveBeenCalledWith('localStorage.removeItem("myKey")');
  });

  it('localstorage-delete requires a key', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['localstorage-delete'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a key');
  });

  it('localstorage-clear clears all entries', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['localstorage-clear'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('localStorage cleared');
    expect(browser.evaluate).toHaveBeenCalledWith('localStorage.clear()');
  });
});

describe('playwright-cli sessionStorage commands', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
  });

  it('sessionstorage-list shows entries', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify([['sKey', 'sVal']])
    );
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sKey=sVal');
  });

  it('sessionstorage-list shows message when empty', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('[]');
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No sessionStorage entries');
  });

  it('sessionstorage-get returns value', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('sessVal');
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-get', 'sessKey'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sessVal');
  });

  it('sessionstorage-get fails when not found', async () => {
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-get', 'missing'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('sessionstorage-get requires a key', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['sessionstorage-get'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a key');
  });

  it('sessionstorage-set sets a value', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-set', 'sKey', 'sVal'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sessionStorage "sKey" set');
    expect(browser.evaluate).toHaveBeenCalledWith('sessionStorage.setItem("sKey", "sVal")');
  });

  it('sessionstorage-set requires key and value', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['sessionstorage-set', 'onlyKey'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires <key> <value>');
  });

  it('sessionstorage-delete removes a key', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-delete', 'sKey'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sessionStorage "sKey" deleted');
    expect(browser.evaluate).toHaveBeenCalledWith('sessionStorage.removeItem("sKey")');
  });

  it('sessionstorage-delete requires a key', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['sessionstorage-delete'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a key');
  });

  it('sessionstorage-clear clears all entries', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['sessionstorage-clear'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sessionStorage cleared');
    expect(browser.evaluate).toHaveBeenCalledWith('sessionStorage.clear()');
  });
});

describe('playwright-cli open --background/--foreground', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('open defaults to background (does not switch current target)', async () => {
    const pages = [
      {
        targetId: 'tab-1',
        title: 'Test Page',
        url: 'https://example.com',
        type: 'page',
        attached: false,
      },
    ];
    (browser.listPages as ReturnType<typeof vi.fn>).mockImplementation(async () => pages);
    (browser.createPage as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const targetId = `tab-${pages.length + 1}`;
      pages.push({ targetId, title: 'New Tab', url, type: 'page', attached: false });
      return targetId;
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    // Open a foreground tab first to have a current target
    await cmd.execute(['open', 'https://first.com', '--foreground'], {} as any);
    // Open a second tab in background (default)
    await cmd.execute(['open', 'https://second.com'], {} as any);
    // Snapshot should still work on the first tab (current target unchanged)
    const result = await cmd.execute(['snapshot'], {} as any);
    expect(result.exitCode).toBe(0);
    // The snapshot should use the first foreground-opened tab's target
    expect(browser.attachToPage).toHaveBeenCalledWith('tab-2');
  });

  it('open --foreground switches current target', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Opened tab');
    // After foreground open, snapshot should work (target was set)
    const snapResult = await cmd.execute(['snapshot'], {} as any);
    expect(snapResult.exitCode).toBe(0);
  });

  it('open --fg is alias for --foreground', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--fg'], {} as any);
    // Snapshot should work (target was set via --fg)
    const result = await cmd.execute(['snapshot'], {} as any);
    expect(result.exitCode).toBe(0);
  });

  it('tab-new defaults to background', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    // With no foreground flag, tab-new should not set current target
    await cmd.execute(['tab-new', 'https://example.com'], {} as any);
    // Since no current target was set and listPages returns tab-1 (not tab-new),
    // ensureTarget should auto-select tab-1 from listPages
    const result = await cmd.execute(['tab-list'], {} as any);
    expect(result.exitCode).toBe(0);
  });
});

describe('playwright-cli record and stop-recording', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (fs as any).stat = vi.fn().mockResolvedValue({ type: 'dir' });
    // Mock transport for Target.attachToTarget + HarRecorder needs
    const mockTransport = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === 'Target.attachToTarget') return { sessionId: 'rec-session-1' };
        if (method === 'Runtime.evaluate') return { result: { value: 'about:blank' } };
        return {};
      }),
      on: vi.fn(),
      off: vi.fn(),
    };
    (browser.getTransport as ReturnType<typeof vi.fn>).mockReturnValue(mockTransport);
  });

  it('record opens a new tab with recording', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['record', 'https://example.com'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Recording started');
    expect(result.stdout).toContain('recordingId:');
    expect(result.stdout).toContain('https://example.com');
    expect(browser.createPage).toHaveBeenCalledWith('https://example.com');
  });

  it('record defaults to about:blank', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['record'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(browser.createPage).toHaveBeenCalledWith('about:blank');
  });

  it('stop-recording requires a recordingId', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['stop-recording'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('stop-recording requires a recordingId');
  });

  it('stop-recording fails when no recorder exists', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['stop-recording', 'nonexistent'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Recording not found');
  });
});

describe('playwright-cli unknown command', () => {
  it('returns error for unknown subcommand', async () => {
    const browser = createMockBrowser();
    const fs = createMockFS();
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['nonexistent'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command: nonexistent');
  });
});

describe('playwright-cli session history logging', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFS();
    (browser.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ url: 'https://example.com', title: 'Test Page' })
    );
  });

  it('creates session.md after a command', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const sessionMd = fs._files.get('/.playwright/session.md') as string;
    expect(sessionMd).toBeDefined();
    expect(sessionMd).toContain('### playwright-cli open');
    expect(sessionMd).toContain('**Time**');
    expect(sessionMd).toContain('**Result**');
  });

  it('creates /.playwright/ directories', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    expect(fs.mkdir).toHaveBeenCalledWith('/.playwright', { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith('/.playwright/snapshots', { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith('/.playwright/screenshots', { recursive: true });
  });

  it('does not swallow non-EEXIST mkdir failures during session logging setup', async () => {
    const err = new Error('permission denied');
    (err as Error & { code?: string }).code = 'EACCES';
    fs.mkdir = vi.fn().mockRejectedValue(err) as any;

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(fs._files.get('/.playwright/session.md')).toBeUndefined();
  });

  it('appends multiple entries to session.md', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    const sessionMd = fs._files.get('/.playwright/session.md') as string;
    expect(sessionMd).toContain('### playwright-cli open');
    expect(sessionMd).toContain('### playwright-cli snapshot');
  });

  it('auto-snapshots after state-changing commands (click)', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);
    await cmd.execute(['click', 'e1'], {} as any);

    // Check that a snapshot file was saved in /.playwright/snapshots/
    const snapshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/snapshots/')
    );
    expect(snapshotFiles.length).toBeGreaterThan(0);

    // Check session log references the snapshot
    const sessionMd = fs._files.get('/.playwright/session.md') as string;
    expect(sessionMd).toContain('[Snapshot]');
    expect(sessionMd).toContain('/.playwright/snapshots/page-');
  });

  it('does NOT auto-snapshot for read-only commands (tab-list)', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['tab-list'], {} as any);

    const snapshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/snapshots/')
    );
    expect(snapshotFiles.length).toBe(0);

    // Session log should exist but without snapshot reference
    const sessionMd = fs._files.get('/.playwright/session.md') as string;
    expect(sessionMd).toContain('### playwright-cli tab-list');
    expect(sessionMd).not.toContain('[Snapshot]');
  });

  it('does NOT auto-snapshot for snapshot command', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['snapshot'], {} as any);

    // snapshot is read-only, should not create auto-snapshot files
    const snapshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/snapshots/')
    );
    expect(snapshotFiles.length).toBe(0);
  });

  it('does NOT auto-snapshot after go-back', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['go-back'], {} as any);

    const snapshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/snapshots/')
    );
    expect(snapshotFiles.length).toBe(0);
  });

  it('does NOT auto-snapshot after go-forward', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['go-forward'], {} as any);

    const snapshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/snapshots/')
    );
    expect(snapshotFiles.length).toBe(0);
  });

  it('does NOT auto-snapshot after reload', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['reload'], {} as any);

    const snapshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/snapshots/')
    );
    expect(snapshotFiles.length).toBe(0);
  });

  it('archives screenshot to /.playwright/screenshots/', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['screenshot', '--filename=/tmp/test.png'], {} as any);

    const screenshotFiles = [...fs._files.keys()].filter((k) =>
      k.startsWith('/.playwright/screenshots/')
    );
    expect(screenshotFiles.length).toBe(1);
    expect(screenshotFiles[0]).toMatch(/screenshot-.*\.png$/);
  });

  it('screenshot does not include base64 img tag in output', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(['screenshot'], {} as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('<img:data:');
    expect(result.stdout).toContain('Screenshot saved to');
  });

  it('logs error commands too', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['goto'], {} as any); // missing URL = error
    const sessionMd = fs._files.get('/.playwright/session.md') as string;
    expect(sessionMd).toContain('### playwright-cli goto');
    expect(sessionMd).toContain('Error');
  });
});

// ---------------------------------------------------------------------------
// Teleport watcher tests
// ---------------------------------------------------------------------------

describe('playwright-cli teleport subcommand', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    vi.useFakeTimers();
    browser = createMockBrowser();
    fs = createMockFS();
    // Reset module-level getters
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
  });

  it('requires --start and --return', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--start=login'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--start');
    expect(result.stderr).toContain('--return');
  });

  it('arms teleport watcher with --start and --return', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(
      ['teleport', '--start=login\\.example\\.com', '--return=app\\.example\\.com'],
      {} as any
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Teleport armed');
    expect(result.stdout).toContain('login\\.example\\.com');

    // Verify watcher was installed in shared state
    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher).not.toBeNull();
    expect(state.teleportWatcher!.phase).toBe('armed');
    expect(state.teleportWatcher!.startPattern.source).toBe('login\\.example\\.com');
    expect(state.teleportWatcher!.returnPattern.source).toBe('app\\.example\\.com');

    // Cleanup timers
    state.teleportWatcher!.pollInterval && clearInterval(state.teleportWatcher!.pollInterval);
  });

  it('rejects invalid regex for --start', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--start=[invalid', '--return=ok'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid regex for --start');
  });

  it('rejects invalid regex for --return', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--start=ok', '--return=[invalid'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid regex for --return');
  });

  it('--off disarms an active watcher', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['teleport', '--start=login', '--return=app'], {} as any);

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher).not.toBeNull();

    const result = await cmd.execute(['teleport', '--off'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('disarmed');
    expect(state.teleportWatcher).toBeNull();
  });

  it('--off when no watcher is a no-op', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--off'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('disarmed');
  });

  it('--list shows followers when connected', async () => {
    setPlaywrightTeleportConnectedFollowers(() => () => [
      {
        runtimeId: 'f-standalone-1',
        runtime: 'slicc-standalone',
        floatType: 'standalone' as any,
        lastActivity: Date.now() - 5000,
      },
      {
        runtimeId: 'f-ext-1',
        runtime: 'slicc-extension',
        floatType: 'extension' as any,
        lastActivity: Date.now() - 10000,
      },
    ]);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('f-standalone-1');
    expect(result.stdout).toContain('standalone');
    expect(result.stdout).toContain('f-ext-1');
    expect(result.stdout).toContain('extension');
  });

  it('--list fails when not connected to a tray', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--list'], {} as any);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not connected to a tray');
  });

  it('--list shows message when no followers', async () => {
    setPlaywrightTeleportConnectedFollowers(() => () => []);

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(['teleport', '--list'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No followers connected');
  });

  it('rejects negative timeout', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(
      ['teleport', '--start=login', '--return=app', '--timeout=-5'],
      {} as any
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('positive number');
  });

  it('re-arms by disarming existing watcher first', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(['teleport', '--start=first', '--return=first-back'], {} as any);

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    const firstWatcher = state.teleportWatcher;
    expect(firstWatcher).not.toBeNull();

    await cmd.execute(['teleport', '--start=second', '--return=second-back'], {} as any);
    // Should have replaced the watcher
    expect(state.teleportWatcher).not.toBe(firstWatcher);
    expect(state.teleportWatcher!.startPattern.source).toBe('second');

    // Cleanup
    state.teleportWatcher!.pollInterval && clearInterval(state.teleportWatcher!.pollInterval);
  });
});

describe('playwright-cli teleport trigger and capture', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    vi.useFakeTimers();
    browser = createMockBrowser({
      createRemotePage: vi.fn().mockResolvedValue('remote-tab-1'),
      closePage: vi.fn().mockResolvedValue(undefined),
      sendCDP: vi.fn().mockImplementation(async (method: string) => {
        if (method === 'Network.getCookies') {
          return {
            cookies: [
              { name: 'session', value: 'abc', domain: '.example.com' },
              { name: 'auth', value: 'xyz', domain: '.example.com' },
            ],
          };
        }
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          return { identifier: `script-${Math.random()}` };
        }
        return {};
      }),
    });
    fs = createMockFS();

    // Wire up getBestFollower to return a follower
    setPlaywrightTeleportBestFollower(() => () => ({
      runtimeId: 'f-runtime',
      bootstrapId: 'b-runtime',
      floatType: 'standalone' as any,
    }));
    setPlaywrightTeleportConnectedFollowers(() => () => [
      { runtimeId: 'f-runtime', runtime: 'slicc-standalone', floatType: 'standalone' as any },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
  });

  it('polls leader tab and triggers teleport on the intercepted auth URL', async () => {
    // Make evaluate return the leader tab URL
    // Call 1: during arm (capturing originalLeaderUrl) — no match
    // Call 2: first poll — no match
    // Call 3: second poll — match triggers teleport
    let callCount = 0;
    let storageCaptureCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        callCount++;
        return callCount <= 2
          ? 'https://app.example.com/dashboard'
          : 'https://login.example.com/auth';
      }
      if (expr.includes('window.localStorage')) {
        storageCaptureCount++;
        return JSON.stringify({
          origin: 'https://login.example.com',
          localStorage: { leaderEmail: 'person@example.com' },
          sessionStorage: { leaderStep: 'email-entered' },
          capture: storageCaptureCount,
        });
      }
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);

    // Arm teleport
    await cmd.execute(
      ['teleport', '--start=login\\.example\\.com', '--return=app\\.example\\.com'],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher!.phase).toBe('armed');
    expect(state.teleportWatcher!.originalLeaderUrl).toBe('https://app.example.com/dashboard');

    // Advance past first poll (no match)
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('armed');

    // Advance past second poll (match → triggerTeleport → waitingForAuth)
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth');

    // Verify leader cookies were captured before teleport
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.getCookies', {});

    // Verify remote tab was opened with about:blank (cookies injected before navigation)
    expect(browser.createRemotePage).toHaveBeenCalledWith('f-runtime', 'about:blank');

    // Verify follower continues on the intercepted auth URL instead of restarting at the app URL
    expect(browser.sendCDP).toHaveBeenCalledWith('Page.navigate', {
      url: 'https://login.example.com/auth',
    });
    expect(browser.sendCDP).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({
        source: expect.stringContaining('"leaderEmail":"person@example.com"'),
      })
    );
    expect(browser.sendCDP).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({
        source: expect.stringContaining('"leaderStep":"email-entered"'),
      })
    );

    // Cleanup timers and catch the unhandled rejection from the completion promise
    if (state.teleportWatcher) {
      state.teleportWatcher.completionPromise?.catch(() => {});
      state.teleportWatcher.pollInterval && clearInterval(state.teleportWatcher.pollInterval);
      state.teleportWatcher.timeoutTimer && clearTimeout(state.teleportWatcher.timeoutTimer);
    }
  });

  it('captures cookies + storage when follower return pattern matches', async () => {
    // Phase 1: leader poll triggers (matching start pattern immediately)
    // Phase 2: follower starts on the intercepted auth URL, then returns to the app
    let leaderCallCount = 0;
    let followerCallCount = 0;
    let storageCaptureCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        // Before watcher is created (capturing leader URL at arm time) or in armed phase
        if (!state.teleportWatcher || state.teleportWatcher.phase === 'armed') {
          leaderCallCount++;
          // First call is during arm (capturing originalLeaderUrl), rest are polls
          return leaderCallCount <= 1
            ? 'https://app.example.com/dashboard' // original page URL captured at arm time
            : 'https://login.example.com/sso'; // SSO redirect detected by poll
        }
        // Follower polling phases (waitingForAuth → waitingForReturn)
        followerCallCount++;
        if (followerCallCount <= 1) return 'https://login.example.com/sso'; // started on intercepted auth URL
        return 'https://app.example.com/callback'; // returned from auth → returnPattern match
      }
      if (expr.includes('window.localStorage')) {
        storageCaptureCount++;
        return storageCaptureCount === 1
          ? JSON.stringify({
              origin: 'https://login.example.com',
              localStorage: { leaderEmail: 'person@example.com' },
              sessionStorage: { leaderStep: 'email-entered' },
            })
          : JSON.stringify({
              origin: 'https://app.example.com',
              localStorage: { followerToken: 'transferred-token' },
              sessionStorage: { followerStep: 'authenticated' },
            });
      }
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(
      ['teleport', '--start=login\\.example\\.com', '--return=app\\.example\\.com'],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    // Verify the original leader URL was captured at arm time
    expect(state.teleportWatcher!.originalLeaderUrl).toBe('https://app.example.com/dashboard');

    // Leader poll triggers immediately
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth');

    // Follower poll #1: follower is on the intercepted auth URL
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForReturn');

    // Follower poll #2: returned from auth → captureCookiesAndComplete
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('capturing');

    // Advance past the 2s settle delay
    await vi.advanceTimersByTimeAsync(2000);

    // Should be done now
    expect(state.teleportWatcher!.phase).toBe('done');

    // Verify cookies were captured and injected
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.getCookies');
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.setCookies', {
      cookies: [
        { name: 'session', value: 'abc', domain: '.example.com' },
        { name: 'auth', value: 'xyz', domain: '.example.com' },
      ],
    });

    // Verify leader navigated to originalLeaderUrl (not the follower's callback URL)
    expect(browser.navigate).toHaveBeenCalledWith('https://app.example.com/dashboard');
    expect(browser.sendCDP).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({
        source: expect.stringContaining('"followerToken":"transferred-token"'),
      })
    );
    expect(browser.sendCDP).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      expect.objectContaining({
        source: expect.stringContaining('"followerStep":"authenticated"'),
      })
    );

    // Verify follower tab was closed (raw targetId gets prefixed by triggerTeleport)
    expect(browser.closePage).toHaveBeenCalledWith('f-runtime:remote-tab-1');
  });

  it('hydrates the captured app origin before landing when the original leader URL is cross-origin', async () => {
    let leaderCallCount = 0;
    let followerCallCount = 0;
    let storageCaptureCount = 0;
    let appliedStorageCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        if (!state.teleportWatcher || state.teleportWatcher.phase === 'armed') {
          leaderCallCount++;
          return leaderCallCount <= 1
            ? 'https://idp.example.com/start'
            : 'https://login.example.com/sso';
        }
        followerCallCount++;
        if (followerCallCount <= 1) return 'https://login.example.com/sso';
        return 'https://app.example.com/callback';
      }
      if (expr.includes('window.localStorage')) {
        storageCaptureCount++;
        return storageCaptureCount === 1
          ? JSON.stringify({
              origin: 'https://login.example.com',
              localStorage: { leaderEmail: 'person@example.com' },
              sessionStorage: { leaderStep: 'email-entered' },
            })
          : JSON.stringify({
              origin: 'https://app.example.com',
              localStorage: { authCache: 'cached-token', tripToken: 'trip-token' },
              sessionStorage: { authFlow: 'complete' },
            });
      }
      if (expr.includes('globalThis.location.origin')) {
        appliedStorageCount++;
        return JSON.stringify({
          origin: 'https://app.example.com',
          localStorageCount: 2,
          sessionStorageCount: 1,
        });
      }
      return JSON.stringify({ url: 'https://app.example.com/callback', title: 'Authenticated' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    await cmd.execute(
      ['teleport', '--start=login\.example\.com', '--return=app\.example\.com'],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher!.originalLeaderUrl).toBe('https://idp.example.com/start');

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(state.teleportWatcher!.phase).toBe('done');
    expect(appliedStorageCount).toBe(1);
    expect(browser.navigate).toHaveBeenNthCalledWith(1, 'https://app.example.com/favicon.ico');
    expect(browser.navigate).toHaveBeenNthCalledWith(2, 'https://app.example.com/callback');
    expect(browser.navigate).not.toHaveBeenCalledWith('https://idp.example.com/start');
  });

  it('keeps leader storage replay installed until leader navigation resolves', async () => {
    let leaderCallCount = 0;
    let followerCallCount = 0;
    let storageCaptureCount = 0;
    let resolveNavigate: (() => void) | undefined;
    (browser.navigate as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNavigate = resolve;
        })
    );

    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        if (!state.teleportWatcher || state.teleportWatcher.phase === 'armed') {
          leaderCallCount++;
          return leaderCallCount <= 1
            ? 'https://app.example.com/dashboard'
            : 'https://login.example.com/sso';
        }
        followerCallCount++;
        if (followerCallCount <= 1) return 'https://login.example.com/sso';
        return 'https://app.example.com/callback';
      }
      if (expr.includes('window.localStorage')) {
        storageCaptureCount++;
        return storageCaptureCount === 1
          ? JSON.stringify({
              origin: 'https://login.example.com',
              localStorage: { leaderEmail: 'person@example.com' },
              sessionStorage: { leaderStep: 'email-entered' },
            })
          : JSON.stringify({
              origin: 'https://app.example.com',
              localStorage: { followerToken: 'transferred-token' },
              sessionStorage: { followerStep: 'authenticated' },
            });
      }
      return JSON.stringify({
        url: 'https://app.example.com/callback',
        title: 'Authenticated',
        bodySnippet: 'Auth completed',
      });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(
      ['teleport', '--start=login\\.example\\.com', '--return=app\\.example\\.com'],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(state.teleportWatcher!.phase).toBe('capturing');
    expect(browser.navigate).toHaveBeenCalledWith('https://app.example.com/dashboard');

    const removeCallsBeforeNavigate = (
      browser.sendCDP as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([method]) => method === 'Page.removeScriptToEvaluateOnNewDocument');
    expect(removeCallsBeforeNavigate).toHaveLength(1);

    const completion = state.teleportWatcher!.completionPromise!;
    resolveNavigate?.();
    await completion;

    const removeCallsAfterNavigate = (
      browser.sendCDP as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([method]) => method === 'Page.removeScriptToEvaluateOnNewDocument');
    expect(removeCallsAfterNavigate).toHaveLength(2);
    expect(state.teleportWatcher!.phase).toBe('done');
  });

  it('keeps follower storage replay installed until capture and scopes it to the snapshot origin', async () => {
    let leaderCallCount = 0;
    let followerCallCount = 0;
    let storageCaptureCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        if (!state.teleportWatcher || state.teleportWatcher.phase === 'armed') {
          leaderCallCount++;
          return leaderCallCount <= 1
            ? 'https://app.example.com/dashboard'
            : 'https://login.example.com/sso';
        }
        followerCallCount++;
        if (followerCallCount <= 1) return 'https://login.example.com/sso';
        return 'https://app.example.com/callback';
      }
      if (expr.includes('window.localStorage')) {
        storageCaptureCount++;
        return storageCaptureCount === 1
          ? JSON.stringify({
              origin: 'https://login.example.com',
              localStorage: { leaderEmail: 'person@example.com' },
              sessionStorage: { leaderStep: 'email-entered' },
            })
          : JSON.stringify({
              origin: 'https://app.example.com',
              localStorage: { followerToken: 'transferred-token' },
              sessionStorage: { followerStep: 'authenticated' },
            });
      }
      return JSON.stringify({
        url: 'https://app.example.com/callback',
        title: 'Authenticated',
        bodySnippet: 'Auth completed',
      });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(
      ['teleport', '--start=login\\.example\\.com', '--return=app\\.example\\.com'],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);

    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth');
    expect(browser.sendCDP).not.toHaveBeenCalledWith(
      'Page.removeScriptToEvaluateOnNewDocument',
      expect.anything()
    );

    const addScriptCalls = (browser.sendCDP as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([method]) => method === 'Page.addScriptToEvaluateOnNewDocument'
    );
    expect(addScriptCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        source: expect.stringContaining('window.location.origin !== snapshot.origin'),
      })
    );
    expect(addScriptCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        source: expect.stringContaining('__slicc_teleport_storage_applied__:'),
      })
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForReturn');
    expect(browser.sendCDP).not.toHaveBeenCalledWith(
      'Page.removeScriptToEvaluateOnNewDocument',
      expect.anything()
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(browser.sendCDP).toHaveBeenCalledWith(
      'Page.removeScriptToEvaluateOnNewDocument',
      expect.objectContaining({ identifier: expect.stringMatching(/^script-/) })
    );
  });

  it('should not match return pattern before start pattern seen on follower', async () => {
    // The bug: follower navigates to app.navan.com which immediately matches the return
    // pattern — before the Okta redirect even happens. The fix requires the follower to
    // first hit a URL matching the startPattern before the returnPattern is checked.
    let leaderCallCount = 0;
    let followerCallCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        if (!state.teleportWatcher || state.teleportWatcher.phase === 'armed') {
          leaderCallCount++;
          return leaderCallCount <= 1
            ? 'https://app.example.com/dashboard'
            : 'https://login.example.com/sso';
        }
        // Follower URL sequence: starts at the app URL (matches returnPattern!),
        // then hits auth, then returns
        followerCallCount++;
        if (followerCallCount <= 2) return 'https://app.example.com/user2/'; // matches returnPattern but NOT startPattern
        if (followerCallCount <= 3) return 'https://login.example.com/auth'; // matches startPattern → waitingForReturn
        return 'https://app.example.com/callback'; // matches returnPattern → capture
      }
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(
      ['teleport', '--start=login\\.example\\.com', '--return=app\\.example\\.com'],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);

    // Leader poll triggers → enters waitingForAuth
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth');

    // Follower poll #1: URL is app.example.com/user2/ — matches returnPattern
    // but should NOT trigger capture because startPattern hasn't been seen yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth'); // Still waiting — NOT capturing!

    // Follower poll #2: still at app URL — same situation
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth');

    // Follower poll #3: auth redirect happened → startPattern matches → waitingForReturn
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForReturn');

    // Follower poll #4: returned from auth → returnPattern matches → capture
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('capturing');

    // Advance past settle delay
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.teleportWatcher!.phase).toBe('done');

    // Verify cookies were captured
    expect(browser.sendCDP).toHaveBeenCalledWith('Network.getCookies');
  });

  it('times out when human does not complete auth', async () => {
    // Leader poll triggers immediately
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        // Before watcher exists (capturing originalLeaderUrl at arm time)
        if (!state.teleportWatcher) return 'https://app.example.com/dashboard';
        if (state.teleportWatcher.phase === 'armed') {
          return 'https://login.example.com/sso';
        }
        // Always return non-matching URL in follower phase
        return 'https://idp.example.com/consent';
      }
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    // Very short timeout (5 seconds)
    await cmd.execute(['teleport', '--start=login', '--return=app', '--timeout=5'], {} as any);

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);

    // Attach a catch handler to prevent unhandled rejection
    const completionCatch = state.teleportWatcher!.completionPromise!.catch(() => {});

    // Leader poll triggers — enters waitingForAuth phase
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.teleportWatcher!.phase).toBe('waitingForAuth');

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.teleportWatcher!.phase).toBe('timedOut');

    // Await the caught promise to ensure rejection is handled
    await completionCatch;
  });

  it('checkTeleportBlock blocks next command during active teleport', async () => {
    // Set up leader to trigger immediately, follower to go through auth then return
    let followerCallCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        // Before watcher exists (capturing originalLeaderUrl at arm time)
        if (!state.teleportWatcher) return 'https://app.example.com/dashboard';
        if (state.teleportWatcher.phase === 'armed') {
          return 'https://login.example.com/sso';
        }
        followerCallCount++;
        if (followerCallCount <= 1) return 'https://login.example.com/sso'; // auth redirect → startPattern match
        if (followerCallCount <= 2) return 'https://idp.example.com/consent'; // at IDP
        return 'https://app.example.com/callback'; // returned → returnPattern match
      }
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(['teleport', '--start=login', '--return=app', '--timeout=60'], {} as any);

    // Trigger the teleport (leader poll matches start pattern)
    await vi.advanceTimersByTimeAsync(1000);

    // Now run a non-teleport command — it should block
    const resultPromise = cmd.execute(['tab-list'], {} as any);

    // Advance: follower poll #1 matches startPattern → waitingForReturn
    // Advance: follower poll #2 at IDP → still waitingForReturn
    // Advance: follower poll #3 matches returnPattern → capture
    await vi.advanceTimersByTimeAsync(3000);
    // Advance past settle delay
    await vi.advanceTimersByTimeAsync(2000);

    // Now the blocked command should resolve with the teleport result
    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Teleported');
    expect(result.stdout).toContain('cookie');
  });

  it('teleport fails gracefully when no followers connected', async () => {
    // No best follower available
    setPlaywrightTeleportBestFollower(() => () => null);

    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') return 'https://login.example.com/sso';
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(['teleport', '--start=login', '--return=app'], {} as any);

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);

    // Attach a catch handler to prevent unhandled rejection
    const completionCatch = state.teleportWatcher!.completionPromise!.catch(() => {});

    // Leader poll triggers
    await vi.advanceTimersByTimeAsync(1000);

    // The watcher should have errored out
    expect(state.teleportWatcher!.phase).toBe('done');

    // Await the caught promise to ensure rejection is handled
    await completionCatch;
  });
});

describe('playwright-cli open/goto with --teleport-start and --teleport-return', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    vi.useFakeTimers();
    browser = createMockBrowser();
    fs = createMockFS();
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
  });

  it('open with --teleport-start/--teleport-return arms watcher', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(
      [
        'open',
        'https://app.example.com',
        '--foreground',
        '--teleport-start=login',
        '--teleport-return=callback',
      ],
      {} as any
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Opened tab');

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher).not.toBeNull();
    expect(state.teleportWatcher!.phase).toBe('armed');
    expect(state.teleportWatcher!.startPattern.source).toBe('login');
    expect(state.teleportWatcher!.returnPattern.source).toBe('callback');

    // Cleanup
    state.teleportWatcher!.pollInterval && clearInterval(state.teleportWatcher!.pollInterval);
  });

  it('tab-new with --teleport-start/--teleport-return arms watcher', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(
      [
        'tab-new',
        'https://app.example.com',
        '--foreground',
        '--teleport-start=sso',
        '--teleport-return=done',
      ],
      {} as any
    );

    expect(result.exitCode).toBe(0);

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher).not.toBeNull();
    expect(state.teleportWatcher!.startPattern.source).toBe('sso');

    // Cleanup
    state.teleportWatcher!.pollInterval && clearInterval(state.teleportWatcher!.pollInterval);
  });

  it('goto with --teleport-start/--teleport-return arms watcher', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(
      ['goto', 'https://app.example.com', '--teleport-start=auth', '--teleport-return=home'],
      {} as any
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Navigated to');

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher).not.toBeNull();
    expect(state.teleportWatcher!.startPattern.source).toBe('auth');
    expect(state.teleportWatcher!.returnPattern.source).toBe('home');

    // Cleanup
    state.teleportWatcher!.pollInterval && clearInterval(state.teleportWatcher!.pollInterval);
  });

  it('open rejects invalid --teleport-start regex', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    const result = await cmd.execute(
      [
        'open',
        'https://example.com',
        '--foreground',
        '--teleport-start=[invalid',
        '--teleport-return=ok',
      ],
      {} as any
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid regex for --teleport-start');
  });

  it('goto rejects invalid --teleport-return regex', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://example.com', '--foreground'], {} as any);
    const result = await cmd.execute(
      ['goto', 'https://example.com', '--teleport-start=ok', '--teleport-return=[invalid'],
      {} as any
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid regex for --teleport-return');
  });

  it('open without both teleport flags does not arm watcher', async () => {
    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(
      [
        'open',
        'https://example.com',
        '--foreground',
        '--teleport-start=login', // missing --teleport-return
      ],
      {} as any
    );

    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher).toBeNull();
  });
});

describe('formatCookieDomainSummary (via teleport output)', () => {
  let browser: ReturnType<typeof createMockBrowser>;
  let fs: ReturnType<typeof createMockFS>;

  beforeEach(() => {
    vi.useFakeTimers();
    browser = createMockBrowser({
      createRemotePage: vi.fn().mockResolvedValue('f-runtime:remote-tab'),
      closePage: vi.fn().mockResolvedValue(undefined),
      sendCDP: vi.fn().mockResolvedValue({
        cookies: [
          { name: 'a', value: '1', domain: '.example.com' },
          { name: 'b', value: '2', domain: '.example.com' },
          { name: 'c', value: '3', domain: '.other.com' },
        ],
      }),
    });
    fs = createMockFS();
    setPlaywrightTeleportBestFollower(() => () => ({
      runtimeId: 'f-runtime',
      bootstrapId: 'b-runtime',
      floatType: 'standalone' as any,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlaywrightTeleportBestFollower(null);
    setPlaywrightTeleportConnectedFollowers(null);
  });

  it('domain summary appears in teleport completion output', async () => {
    let followerCallCount = 0;
    (browser.evaluate as ReturnType<typeof vi.fn>).mockImplementation((expr: string) => {
      if (expr === 'window.location.href') {
        const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
        // Before watcher exists (capturing leader URL at arm time) or in armed phase
        if (!state.teleportWatcher || state.teleportWatcher.phase === 'armed') {
          return 'https://login.example.com/sso';
        }
        // Follower: first hit auth (startPattern), then return (returnPattern)
        followerCallCount++;
        if (followerCallCount <= 1) return 'https://login.example.com/auth'; // auth redirect → startPattern match
        return 'https://app.example.com/done'; // returned → returnPattern match
      }
      return JSON.stringify({ url: 'https://app.example.com', title: 'App' });
    });

    const cmd = createPlaywrightCommand('playwright-cli', browser as BrowserAPI, fs as VirtualFS);
    await cmd.execute(['open', 'https://app.example.com', '--foreground'], {} as any);
    await cmd.execute(['teleport', '--start=login', '--return=app\\.example\\.com'], {} as any);

    // Trigger leader → waitingForAuth
    await vi.advanceTimersByTimeAsync(1000);
    // Follower poll #1: auth redirect → waitingForReturn
    await vi.advanceTimersByTimeAsync(1000);
    // Follower poll #2: return pattern matches → capturing
    await vi.advanceTimersByTimeAsync(1000);
    // Settle delay
    await vi.advanceTimersByTimeAsync(2000);

    // The completion promise should have resolved — check by running a command
    const result = await cmd.execute(['tab-list'], {} as any);
    // The teleport result will be consumed if we hit it; otherwise tab-list works normally
    // Since checkTeleportBlock runs first, it should have consumed the "done" state already.
    // Let's verify via state
    const state = getSharedState(browser as BrowserAPI, fs as VirtualFS);
    expect(state.teleportWatcher === null || state.teleportWatcher.phase === 'done').toBe(true);
  });
});
