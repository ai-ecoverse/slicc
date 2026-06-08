// @vitest-environment jsdom
/**
 * DOM-only tests for `showSyncEnabledDialog` — the avatar-popover dialog
 * that surfaces the leader's join URL after a `host enable` succeeds.
 * Stubs the optional clipboard module so the copy-back button can be
 * exercised without depending on the browser's real clipboard API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ui/clipboard.js', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

import { copyTextToClipboard } from '../../src/ui/clipboard.js';
import { showSyncEnabledDialog } from '../../src/ui/sync-dialog.js';

const mockedCopy = vi.mocked(copyTextToClipboard);

beforeEach(() => {
  document.body.replaceChildren();
  mockedCopy.mockReset();
  mockedCopy.mockResolvedValue(true);
});

describe('showSyncEnabledDialog', () => {
  it('mounts an overlay with the join URL and the copied-state status line', () => {
    showSyncEnabledDialog({
      joinUrl: 'https://slicc.example.com/join#abc',
      copied: true,
    });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.dialog__title')!.textContent).toMatch(/sync is on/i);
    expect(overlay!.textContent).toContain('https://slicc.example.com/join#abc');
    expect(overlay!.textContent).toContain('URL copied to clipboard');
  });

  it('renders the not-copied desc and label when `copied: false`', () => {
    showSyncEnabledDialog({
      joinUrl: 'https://slicc.example.com/join#xyz',
      copied: false,
    });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const desc = overlay.querySelector('.dialog__desc')!;
    expect(desc.textContent).toMatch(/Couldn[\u2019']t copy automatically/);
    // The action button reads "Copy URL" instead of "Copy again".
    const buttons = Array.from(overlay.querySelectorAll('button'));
    const copyBtn = buttons.find((b) => /Copy URL/.test(b.textContent ?? ''));
    expect(copyBtn).toBeDefined();
  });

  it('removes any pre-existing instance before mounting (idempotent)', () => {
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true });
    showSyncEnabledDialog({ joinUrl: 'https://b', copied: true });
    const overlays = document.querySelectorAll('.dialog-overlay[data-sync-dialog]');
    expect(overlays).toHaveLength(1);
    expect(overlays[0].textContent).toContain('https://b');
  });

  it('removes the overlay when Done is clicked', () => {
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const buttons = Array.from(overlay.querySelectorAll('button')) as HTMLButtonElement[];
    const done = buttons.find((b) => b.textContent === 'Done')!;
    done.click();
    expect(document.querySelector('.dialog-overlay[data-sync-dialog]')).toBeNull();
  });

  it('removes the overlay on backdrop click', () => {
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]') as HTMLElement;
    overlay.click();
    expect(document.querySelector('.dialog-overlay[data-sync-dialog]')).toBeNull();
  });

  it('does not remove the overlay on inner click', () => {
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const dialog = overlay.querySelector('.dialog')! as HTMLElement;
    dialog.click();
    expect(document.querySelector('.dialog-overlay[data-sync-dialog]')).not.toBeNull();
  });

  it('copy-again button writes the join URL and updates the status', async () => {
    showSyncEnabledDialog({ joinUrl: 'https://slicc.example.com/join#abc', copied: true });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const copyBtn = Array.from(overlay.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy again'
    ) as HTMLButtonElement;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedCopy).toHaveBeenCalledWith('https://slicc.example.com/join#abc');
    expect(overlay.textContent).toContain('URL copied to clipboard');
  });

  it('copy failure surfaces a manual-copy hint', async () => {
    mockedCopy.mockResolvedValueOnce(false);
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: false });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const copyBtn = Array.from(overlay.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy URL'
    ) as HTMLButtonElement;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(overlay.textContent).toMatch(/Select and copy manually/);
  });

  it('renders a Reset button only when `onReset` is supplied', () => {
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true });
    let overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    expect(
      Array.from(overlay.querySelectorAll('button')).some((b) =>
        /Reset URL/.test(b.textContent ?? '')
      )
    ).toBe(false);

    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true, onReset: async () => {} });
    overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    expect(
      Array.from(overlay.querySelectorAll('button')).some((b) =>
        /Reset URL/.test(b.textContent ?? '')
      )
    ).toBe(true);
  });

  it('Reset button success path clears the URL display and disables buttons', async () => {
    const onReset = vi.fn(async () => {});
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true, onReset });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const buttons = Array.from(overlay.querySelectorAll('button')) as HTMLButtonElement[];
    const resetBtn = buttons.find((b) => /Reset URL/.test(b.textContent ?? ''))!;
    resetBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onReset).toHaveBeenCalled();
    expect(resetBtn.disabled).toBe(true);
    expect(overlay.textContent).toMatch(/Sync URL reset/);
  });

  it('Reset button failure path re-enables buttons and shows the error', async () => {
    const onReset = vi.fn(async () => {
      throw new Error('boom');
    });
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true, onReset });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const buttons = Array.from(overlay.querySelectorAll('button')) as HTMLButtonElement[];
    const resetBtn = buttons.find((b) => /Reset URL/.test(b.textContent ?? ''))!;
    const doneBtn = buttons.find((b) => b.textContent === 'Done')!;
    resetBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(overlay.textContent).toMatch(/Reset failed: boom/);
    expect(resetBtn.disabled).toBe(false);
    expect(doneBtn.disabled).toBe(false);
  });

  it('Reset failure with non-Error rejection still surfaces a string', async () => {
    const onReset = vi.fn(async () => {
      throw 'string-reason';
    });
    showSyncEnabledDialog({ joinUrl: 'https://a', copied: true, onReset });
    const overlay = document.querySelector('.dialog-overlay[data-sync-dialog]')!;
    const resetBtn = Array.from(overlay.querySelectorAll('button')).find((b) =>
      /Reset URL/.test(b.textContent ?? '')
    ) as HTMLButtonElement;
    resetBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(overlay.textContent).toMatch(/Reset failed: string-reason/);
  });
});
