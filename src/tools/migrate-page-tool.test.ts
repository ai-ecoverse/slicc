/**
 * Tests for the migrate_page tool.
 *
 * Covers: schema validation, helper functions, and the
 * extraction pipeline with mocked BrowserAPI and VirtualFS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMigratePageTool,
  deriveProjectPath,
  deriveBranchName,
} from './migrate-page-tool.js';
import type { GitOps } from './migrate-page-tool.js';
import type { BrowserAPI } from '../cdp/index.js';
import type { VirtualFS } from '../fs/index.js';

function createMockGitOps(): GitOps {
  return {
    clone: vi.fn().mockResolvedValue(undefined),
    checkoutNewBranch: vi.fn().mockResolvedValue(undefined),
  };
}

/** Valid base64 string for mock screenshot data. */
const MOCK_SCREENSHOT_BASE64 = 'UE5H';

function createMockBrowser(): BrowserAPI {
  return {
    createPage: vi.fn().mockResolvedValue('target-123'),
    attachToPage: vi.fn().mockResolvedValue('session-abc'),
    evaluate: vi.fn().mockResolvedValue('{}'),
    screenshot: vi.fn().mockResolvedValue(MOCK_SCREENSHOT_BASE64),
    listPages: vi.fn().mockResolvedValue([]),
    navigate: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    detach: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    getAccessibilityTree: vi.fn().mockResolvedValue({}),
    getTransport: vi.fn(),
    getSessionId: vi.fn().mockReturnValue(null),
    getAttachedTargetId: vi.fn().mockReturnValue(null),
  } as unknown as BrowserAPI;
}

function createMockFs(projectExists = true): VirtualFS {
  return {
    exists: vi.fn().mockResolvedValue(projectExists),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    readDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ type: 'directory' }),
    readTextFile: vi.fn().mockResolvedValue(''),
    rm: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    getLightningFS: vi.fn(),
  } as unknown as VirtualFS;
}

// ─── Schema tests ──────────────────────────────────────────────────────────

describe('migrate_page tool schema', () => {
  const browser = createMockBrowser();
  const fs = createMockFs();
  const tool = createMigratePageTool(browser, fs, createMockGitOps());

  it('has the correct tool name', () => {
    expect(tool.name).toBe('migrate_page');
  });

  it('has url in the input schema', () => {
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('url');
  });

  it('has repo in the input schema', () => {
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('repo');
  });

  it('requires url and repo', () => {
    expect(tool.inputSchema.required).toContain('url');
    expect(tool.inputSchema.required).toContain('repo');
  });
});

// ─── Validation tests ──────────────────────────────────────────────────────

describe('migrate_page input validation', () => {
  const browser = createMockBrowser();
  const fs = createMockFs();
  const tool = createMigratePageTool(browser, fs, createMockGitOps());

  it('rejects missing url', async () => {
    const result = await tool.execute({ repo: 'owner/repo' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/url/i);
  });

  it('rejects empty url', async () => {
    const result = await tool.execute({ url: '', repo: 'owner/repo' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/url/i);
  });

  it('rejects missing repo', async () => {
    const result = await tool.execute({ url: 'https://example.com' });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/repo/i);
  });

  it('rejects repo without slash', async () => {
    const result = await tool.execute({
      url: 'https://example.com',
      repo: 'noslash',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/owner\/repo/i);
  });
});

// ─── Helper function tests ─────────────────────────────────────────────────

describe('deriveProjectPath', () => {
  it('extracts repo name from owner/repo format', () => {
    expect(deriveProjectPath('owner/eds-site')).toBe('/shared/eds-site');
  });

  it('handles multi-segment paths', () => {
    expect(deriveProjectPath('org/my-project')).toBe('/shared/my-project');
  });
});

describe('deriveBranchName', () => {
  it('converts path segments to branch slug', () => {
    expect(deriveBranchName('https://example.com/products/overview'))
      .toBe('migrate/products-overview');
  });

  it('uses index for root URL', () => {
    expect(deriveBranchName('https://example.com/'))
      .toBe('migrate/index');
  });

  it('uses index for bare domain', () => {
    expect(deriveBranchName('https://example.com'))
      .toBe('migrate/index');
  });

  it('handles deep paths', () => {
    expect(deriveBranchName('https://example.com/a/b/c'))
      .toBe('migrate/a-b-c');
  });
});

// ─── Pipeline test ─────────────────────────────────────────────────────────

describe('migrate_page extraction pipeline', () => {
  let browser: BrowserAPI;
  let fs: VirtualFS;
  let gitOps: GitOps;

  beforeEach(() => {
    browser = createMockBrowser();
    fs = createMockFs(true);
    gitOps = createMockGitOps();
  });

  it('runs the full extraction pipeline', async () => {
    const tool = createMigratePageTool(browser, fs, gitOps);

    const result = await tool.execute({
      url: 'https://example.com/about',
      repo: 'owner/eds-site',
    });

    expect(result.isError).toBeFalsy();

    // browser.createPage called with the URL
    expect(browser.createPage).toHaveBeenCalledWith(
      'https://example.com/about',
    );

    // browser.attachToPage called with the target ID
    expect(browser.attachToPage).toHaveBeenCalledWith('target-123');

    // browser.evaluate called 4 times: prep + visual tree + brand + metadata
    expect(browser.evaluate).toHaveBeenCalledTimes(4);

    // browser.screenshot called with fullPage
    expect(browser.screenshot).toHaveBeenCalledWith({ fullPage: true });

    // fs.writeFile called for all 5 artifacts
    const writeCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeCalls.length).toBe(5);

    const writtenPaths = writeCalls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(writtenPaths).toContain(
      '/shared/eds-site/.migration/screenshot.png',
    );
    expect(writtenPaths).toContain(
      '/shared/eds-site/.migration/visual-tree.json',
    );
    expect(writtenPaths).toContain(
      '/shared/eds-site/.migration/brand.json',
    );
    expect(writtenPaths).toContain(
      '/shared/eds-site/.migration/metadata.json',
    );
    expect(writtenPaths).toContain(
      '/shared/eds-site/.migration/block-inventory.json',
    );
  });

  it('creates .migration directory', async () => {
    const tool = createMigratePageTool(browser, fs, gitOps);

    await tool.execute({
      url: 'https://example.com/about',
      repo: 'owner/eds-site',
    });

    expect(fs.mkdir).toHaveBeenCalledWith(
      '/shared/eds-site/.migration',
      { recursive: true },
    );
  });

  it('returns extraction result with file paths', async () => {
    const tool = createMigratePageTool(browser, fs, gitOps);

    const result = await tool.execute({
      url: 'https://example.com/about',
      repo: 'owner/eds-site',
    });

    expect(result.content).toContain('screenshot.png');
    expect(result.content).toContain('visual-tree.json');
    expect(result.content).toContain('brand.json');
    expect(result.content).toContain('metadata.json');
    expect(result.content).toContain('block-inventory.json');
  });

  it('clones repo when project does not exist', async () => {
    const freshFs = createMockFs(false);
    const mockGit = createMockGitOps();
    const tool = createMigratePageTool(browser, freshFs, mockGit);

    await tool.execute({
      url: 'https://example.com/',
      repo: 'owner/eds-site',
    });

    expect(freshFs.exists).toHaveBeenCalledWith('/shared/eds-site');
    expect(mockGit.clone).toHaveBeenCalledWith(
      'owner/eds-site',
      '/shared/eds-site',
    );
    expect(mockGit.checkoutNewBranch).toHaveBeenCalledWith(
      '/shared/eds-site',
      'migrate/index',
    );
  });
});
