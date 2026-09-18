import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_TIMEOUT_MS,
  buildScreenShareApprovalHtml,
  runScreenShareApproval,
} from '../../../src/shell/supplemental-commands/computer/screen-approval.js';
import {
  keepAdoptedScreenShare,
  resetScreenShareApprovalLiveForTests,
  shouldAdoptScreenShare,
} from '../../../src/shell/supplemental-commands/computer/screen-share-approval-live.js';

vi.mock('../../../src/shell/tool-ui.js', () => ({
  showToolUI: vi.fn(() => new Promise(() => {})),
  toolUIRegistry: {
    generateId: () => 'ui-screen-1',
    cancel: vi.fn(),
  },
}));

vi.mock('../../../src/base/tool-execution-context.js', () => ({
  getToolExecutionContext: () => ({ onUpdate: vi.fn() }),
}));

describe('screen-share approval card', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetScreenShareApprovalLiveForTests();
  });

  it('renders Share screen without a PickerKind data-picker value', () => {
    const html = buildScreenShareApprovalHtml();
    expect(html).toContain('Share this display');
    expect(html).toContain('data-picker="screenshare"');
    expect(html).not.toContain('data-picker="hid-device"');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
  });

  it('ends live approval on timeout so a late picker grant is dropped', async () => {
    vi.useFakeTimers();
    resetScreenShareApprovalLiveForTests();
    const pending = runScreenShareApproval();
    const rejected = expect(pending).rejects.toThrow(/timed out after 120s/);
    expect(shouldAdoptScreenShare()).toBe(true);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await rejected;
    expect(shouldAdoptScreenShare()).toBe(false);
    const stopped: string[] = [];
    expect(
      keepAdoptedScreenShare('screen9', (handle) => {
        stopped.push(handle);
        return true;
      })
    ).toBe(false);
    expect(stopped).toEqual(['screen9']);
  });
});
