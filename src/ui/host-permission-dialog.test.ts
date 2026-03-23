// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock requestHostPermission before importing the module under test.
vi.mock('../extension/host-permission.js', () => ({
  requestHostPermission: vi.fn(),
}));

import { requestHostPermission } from '../extension/host-permission.js';
import { showHostPermissionDialog } from './host-permission-dialog.js';

const mockRequest = vi.mocked(requestHostPermission);

describe('showHostPermissionDialog', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it('appends dialog overlay to container', () => {
    mockRequest.mockResolvedValue(true);
    showHostPermissionDialog(container, 'read web pages');
    expect(container.querySelector('.dialog-overlay')).not.toBeNull();
    expect(container.querySelector('.dialog')).not.toBeNull();
  });

  it('shows grant and dismiss buttons', () => {
    mockRequest.mockResolvedValue(true);
    showHostPermissionDialog(container, 'read web pages');
    const grant = container.querySelector<HTMLElement>('[data-action="grant"]');
    const dismiss = container.querySelector<HTMLElement>('[data-action="dismiss"]');
    expect(grant).not.toBeNull();
    expect(dismiss).not.toBeNull();
  });

  it('includes the reason text in the dialog', () => {
    mockRequest.mockResolvedValue(true);
    showHostPermissionDialog(container, 'take screenshots');
    const dialog = container.querySelector('.dialog')!;
    expect(dialog.textContent).toContain('take screenshots');
  });

  it('calls chrome.permissions.request on grant click and returns true', async () => {
    mockRequest.mockResolvedValue(true);
    const promise = showHostPermissionDialog(container, 'read web pages');

    const grantBtn = container.querySelector<HTMLElement>('[data-action="grant"]')!;
    grantBtn.click();

    const result = await promise;
    expect(mockRequest).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('returns false when permission request is denied by Chrome', async () => {
    mockRequest.mockResolvedValue(false);
    const promise = showHostPermissionDialog(container, 'read web pages');

    const grantBtn = container.querySelector<HTMLElement>('[data-action="grant"]')!;
    grantBtn.click();

    const result = await promise;
    expect(mockRequest).toHaveBeenCalledOnce();
    expect(result).toBe(false);
  });

  it('returns false when dismissed via "Not now" button', async () => {
    mockRequest.mockResolvedValue(true);
    const promise = showHostPermissionDialog(container, 'read web pages');

    const dismissBtn = container.querySelector<HTMLElement>('[data-action="dismiss"]')!;
    dismissBtn.click();

    const result = await promise;
    expect(mockRequest).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('removes overlay from DOM after grant', async () => {
    mockRequest.mockResolvedValue(true);
    const promise = showHostPermissionDialog(container, 'read web pages');

    const grantBtn = container.querySelector<HTMLElement>('[data-action="grant"]')!;
    grantBtn.click();

    await promise;
    expect(container.querySelector('.dialog-overlay')).toBeNull();
  });

  it('removes overlay from DOM after dismiss', async () => {
    mockRequest.mockResolvedValue(true);
    const promise = showHostPermissionDialog(container, 'read web pages');

    const dismissBtn = container.querySelector<HTMLElement>('[data-action="dismiss"]')!;
    dismissBtn.click();

    await promise;
    expect(container.querySelector('.dialog-overlay')).toBeNull();
  });

  it('returns false when clicking the overlay backdrop', async () => {
    mockRequest.mockResolvedValue(true);
    const promise = showHostPermissionDialog(container, 'read web pages');

    const overlay = container.querySelector<HTMLElement>('.dialog-overlay')!;
    overlay.click();

    const result = await promise;
    expect(result).toBe(false);
    expect(container.querySelector('.dialog-overlay')).toBeNull();
  });

  it('escapes HTML in the reason string', () => {
    mockRequest.mockResolvedValue(true);
    showHostPermissionDialog(container, '<script>alert(1)</script>');
    const dialog = container.querySelector('.dialog')!;
    // The raw script tag should not be present as live HTML
    expect(dialog.querySelector('script')).toBeNull();
    // But the escaped text should be visible
    expect(dialog.textContent).toContain('<script>alert(1)</script>');
  });
});
