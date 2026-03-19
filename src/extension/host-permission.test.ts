/**
 * Tests for host permission check/request utility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tools/tool-ui.js', () => ({
  getToolExecutionContext: vi.fn(),
  showToolUIFromContext: vi.fn(),
}));

describe('hasHostPermission', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns true when chrome.permissions.contains resolves true', async () => {
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn().mockResolvedValue(true),
        request: vi.fn(),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const { hasHostPermission } = await import('./host-permission.js');
    expect(await hasHostPermission()).toBe(true);
    expect(
      (globalThis as unknown as { chrome: { permissions: { contains: ReturnType<typeof vi.fn> } } })
        .chrome.permissions.contains,
    ).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('returns false when chrome.permissions.contains resolves false', async () => {
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn(),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const { hasHostPermission } = await import('./host-permission.js');
    expect(await hasHostPermission()).toBe(false);
  });
});

describe('requestHostPermission', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls chrome.permissions.request with correct args and returns true on grant', async () => {
    const requestMock = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(),
        request: requestMock,
        onRemoved: { addListener: vi.fn() },
      },
    });
    const { requestHostPermission } = await import('./host-permission.js');
    const result = await requestHostPermission();
    expect(result).toBe(true);
    expect(requestMock).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('returns false when permission is denied', async () => {
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(),
        request: vi.fn().mockResolvedValue(false),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const { requestHostPermission } = await import('./host-permission.js');
    expect(await requestHostPermission()).toBe(false);
  });
});

describe('onHostPermissionRevoked', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls callback when <all_urls> is in removed origins', async () => {
    let capturedListener: ((permissions: { origins?: string[] }) => void) | undefined;
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(),
        request: vi.fn(),
        onRemoved: {
          addListener: vi.fn((fn: (permissions: { origins?: string[] }) => void) => {
            capturedListener = fn;
          }),
        },
      },
    });
    const { onHostPermissionRevoked } = await import('./host-permission.js');
    const callback = vi.fn();
    onHostPermissionRevoked(callback);

    capturedListener!({ origins: ['<all_urls>'] });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does not call callback when a different origin is removed', async () => {
    let capturedListener: ((permissions: { origins?: string[] }) => void) | undefined;
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(),
        request: vi.fn(),
        onRemoved: {
          addListener: vi.fn((fn: (permissions: { origins?: string[] }) => void) => {
            capturedListener = fn;
          }),
        },
      },
    });
    const { onHostPermissionRevoked } = await import('./host-permission.js');
    const callback = vi.fn();
    onHostPermissionRevoked(callback);

    capturedListener!({ origins: ['https://example.com/'] });
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not call callback when origins is undefined', async () => {
    let capturedListener: ((permissions: { origins?: string[] }) => void) | undefined;
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(),
        request: vi.fn(),
        onRemoved: {
          addListener: vi.fn((fn: (permissions: { origins?: string[] }) => void) => {
            capturedListener = fn;
          }),
        },
      },
    });
    const { onHostPermissionRevoked } = await import('./host-permission.js');
    const callback = vi.fn();
    onHostPermissionRevoked(callback);

    capturedListener!({});
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('ensureHostPermission', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns true when not in extension mode', async () => {
    // No chrome global at all
    vi.unstubAllGlobals();
    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(true);
  });

  it('returns true when chrome exists but runtime.id is falsy', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(true);
  });

  it('returns true when permission is already granted', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext' },
      permissions: {
        contains: vi.fn().mockResolvedValue(true),
        request: vi.fn(),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(true);
  });

  it('returns false when no tool context is available', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext' },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn(),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const toolUI = await import('../tools/tool-ui.js');
    vi.mocked(toolUI.getToolExecutionContext).mockReturnValue(null);

    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(false);
  });

  it('returns true when user grants permission via approval card', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext' },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn().mockResolvedValue(true),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const toolUI = await import('../tools/tool-ui.js');
    const fakeCtx = { onUpdate: vi.fn(), toolName: 'bash', toolCallId: '1' };
    vi.mocked(toolUI.getToolExecutionContext).mockReturnValue(fakeCtx);
    vi.mocked(toolUI.showToolUIFromContext).mockImplementation(
      async (req) => {
        const result = await req.onAction!('grant');
        return result;
      },
    );

    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(true);
  });

  it('returns false when user denies via approval card', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext' },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn(),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const toolUI = await import('../tools/tool-ui.js');
    const fakeCtx = { onUpdate: vi.fn(), toolName: 'bash', toolCallId: '1' };
    vi.mocked(toolUI.getToolExecutionContext).mockReturnValue(fakeCtx);
    vi.mocked(toolUI.showToolUIFromContext).mockImplementation(
      async (req) => {
        const result = await req.onAction!('deny');
        return result;
      },
    );

    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(false);
  });

  it('returns false when Chrome denies the permission request', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext' },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn().mockResolvedValue(false),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const toolUI = await import('../tools/tool-ui.js');
    const fakeCtx = { onUpdate: vi.fn(), toolName: 'bash', toolCallId: '1' };
    vi.mocked(toolUI.getToolExecutionContext).mockReturnValue(fakeCtx);
    vi.mocked(toolUI.showToolUIFromContext).mockImplementation(
      async (req) => {
        const result = await req.onAction!('grant');
        return result;
      },
    );

    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(false);
  });

  it('returns false when showToolUIFromContext returns null', async () => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-ext' },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn(),
        onRemoved: { addListener: vi.fn() },
      },
    });
    const toolUI = await import('../tools/tool-ui.js');
    const fakeCtx = { onUpdate: vi.fn(), toolName: 'bash', toolCallId: '1' };
    vi.mocked(toolUI.getToolExecutionContext).mockReturnValue(fakeCtx);
    vi.mocked(toolUI.showToolUIFromContext).mockResolvedValue(null);

    const { ensureHostPermission } = await import('./host-permission.js');
    expect(await ensureHostPermission()).toBe(false);
  });
});
