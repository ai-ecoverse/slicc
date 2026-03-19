/**
 * Tests for host permission check/request utility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
