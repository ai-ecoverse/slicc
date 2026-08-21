/**
 * The session-sharing dialog's pure model: which tabs exist, which one opens,
 * how the join link is masked, and the exact copy a user reads. DOM-free —
 * `sync-dialog.test.ts` covers the rendering.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSyncDialogTabs,
  cliFollowCommand,
  defaultSyncDialogTab,
  maskJoinUrl,
  revokeConfirmLabel,
  sharingSummary,
  syncDialogCopy,
} from '../../src/ui/sync-dialog-model.js';

describe('buildSyncDialogTabs', () => {
  it('offers one tab per follower kind when nothing is connected', () => {
    expect(buildSyncDialogTabs(0).map((tab) => tab.id)).toEqual(['browser', 'iphone', 'terminal']);
  });

  it('prepends Status, badged with the count, once something is connected', () => {
    const tabs = buildSyncDialogTabs(3);
    expect(tabs.map((tab) => tab.id)).toEqual(['status', 'browser', 'iphone', 'terminal']);
    expect(tabs[0].badge).toBe(3);
  });

  it('never badges the how-to tabs', () => {
    for (const tab of buildSyncDialogTabs(2).slice(1)) expect(tab.badge).toBeUndefined();
  });
});

describe('defaultSyncDialogTab', () => {
  it('opens on Browser before anything is connected', () => {
    expect(defaultSyncDialogTab(0)).toBe('browser');
  });

  it('opens on Status once something is', () => {
    expect(defaultSyncDialogTab(1)).toBe('status');
  });
});

describe('maskJoinUrl', () => {
  it('hides the token but keeps the shape of the link', () => {
    expect(maskJoinUrl('https://tray.example.com/join/s3cr3t')).toBe(
      'https://tray.example.com/join/••••••••'
    );
  });

  it('does not percent-encode the mask', () => {
    expect(maskJoinUrl('https://tray.example.com/join/s3cr3t')).not.toContain('%');
  });

  it('preserves a query string and fragment', () => {
    expect(maskJoinUrl('https://tray.example.com/join/tok?a=1#f')).toBe(
      'https://tray.example.com/join/••••••••?a=1#f'
    );
  });

  it('masks the token under a path prefix', () => {
    expect(maskJoinUrl('https://tray.example.com/t/join/tok')).toContain('/t/join/•');
  });

  it('returns anything it cannot parse unchanged', () => {
    expect(maskJoinUrl('not a url')).toBe('not a url');
    expect(maskJoinUrl('')).toBe('');
  });

  it('returns a URL with no /join/ segment unchanged', () => {
    expect(maskJoinUrl('https://tray.example.com/other/tok')).toBe(
      'https://tray.example.com/other/tok'
    );
  });

  it('returns a /join/ with an empty token unchanged', () => {
    expect(maskJoinUrl('https://tray.example.com/join/')).toBe('https://tray.example.com/join/');
  });
});

describe('cliFollowCommand', () => {
  it('hands over the runner-bearing form, which is the one that works', () => {
    expect(cliFollowCommand('https://tray.example.com/join/tok')).toBe(
      'slicc https://tray.example.com/join/tok follow bash -c'
    );
  });
});

describe('syncDialogCopy', () => {
  it('routes the browser user through the avatar menu', () => {
    const [lead] = syncDialogCopy('browser');
    expect(lead).toMatch(/Connect to another browser/);
  });

  it('names both iPhone routes — the paste field and iCloud', () => {
    const [lead, note] = syncDialogCopy('iphone');
    expect(lead).toMatch(/Settings → Join link/);
    expect(note).toMatch(/iCloud Sessions/);
  });

  it('warns the terminal user about what follow grants', () => {
    const [, note] = syncDialogCopy('terminal');
    expect(note).toMatch(/run commands on that machine/);
  });

  it('keeps every tab to two lines', () => {
    for (const tab of ['browser', 'iphone', 'terminal'] as const) {
      expect(syncDialogCopy(tab)).toHaveLength(2);
    }
  });
});

describe('sharingSummary', () => {
  it('says nothing is connected at zero', () => {
    expect(sharingSummary(0)).toBe('Nothing connected yet.');
  });

  it('agrees with itself in number', () => {
    expect(sharingSummary(1)).toBe('1 device is connected.');
    expect(sharingSummary(4)).toBe('4 devices are connected.');
  });
});

describe('revokeConfirmLabel', () => {
  it('names the blast radius', () => {
    expect(revokeConfirmLabel(1)).toMatch(/1 connected device will be disconnected/);
    expect(revokeConfirmLabel(3)).toMatch(/3 connected devices will be disconnected/);
  });

  it('still explains itself with nothing attached', () => {
    expect(revokeConfirmLabel(0)).toMatch(/old link stops working/);
  });
});
