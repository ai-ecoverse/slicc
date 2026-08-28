import { describe, expect, it, vi } from 'vitest';
import {
  applyTeleportStorageSnapshot,
  buildTeleportStorageApplyScript,
  buildTeleportStorageHydrationUrl,
  buildTeleportStorageInitScript,
  captureTeleportPageDiagnostics,
  captureTeleportStorageSnapshot,
  chooseTeleportLeaderLandingUrl,
  countTeleportStorageEntries,
  EMPTY_TELEPORT_STORAGE,
  formatCookieDomainSummary,
  installTeleportStorageInitScript,
  shouldCaptureTeleportDiagnostics,
  tryGetTeleportUrlOrigin,
} from '../../../../src/shell/supplemental-commands/playwright/teleport-storage.js';
import type { TeleportStorageSnapshot } from '../../../../src/shell/supplemental-commands/playwright/types.js';

const sampleSnapshot: TeleportStorageSnapshot = {
  origin: 'https://example.com',
  localStorage: { a: '1' },
  sessionStorage: { b: '2' },
};

describe('teleport-storage pure helpers', () => {
  it('formats cookie domain counts descending', () => {
    expect(
      formatCookieDomainSummary([
        { domain: '.a.com' },
        { domain: '.b.com' },
        { domain: '.a.com' },
        {},
      ])
    ).toBe('2 .a.com, 1 .b.com, 1 unknown');
  });

  it('counts storage entries and treats empty as zero', () => {
    expect(countTeleportStorageEntries(EMPTY_TELEPORT_STORAGE)).toBe(0);
    expect(countTeleportStorageEntries(sampleSnapshot)).toBe(2);
  });

  it('parses origins and builds hydration URLs safely', () => {
    expect(tryGetTeleportUrlOrigin()).toBeNull();
    expect(tryGetTeleportUrlOrigin('not a url')).toBeNull();
    expect(tryGetTeleportUrlOrigin('https://example.com/path')).toBe('https://example.com');
    expect(buildTeleportStorageHydrationUrl('https://example.com')).toBe(
      'https://example.com/favicon.ico'
    );
    expect(buildTeleportStorageHydrationUrl('not-an-origin')).toBe('not-an-origin');
  });

  it('chooses a landing URL whose origin matches storage', () => {
    expect(
      chooseTeleportLeaderLandingUrl(
        'https://example.com',
        'https://example.com/start',
        'https://other.com/end'
      )
    ).toBe('https://example.com/start');
    expect(
      chooseTeleportLeaderLandingUrl(
        'https://example.com',
        'https://other.com/start',
        'https://example.com/end'
      )
    ).toBe('https://example.com/end');
    expect(chooseTeleportLeaderLandingUrl('https://example.com')).toBe('https://example.com');
    expect(chooseTeleportLeaderLandingUrl('', 'https://fallback.test')).toBe(
      'https://fallback.test'
    );
  });

  it('embeds the snapshot into init and apply scripts', () => {
    const init = buildTeleportStorageInitScript(sampleSnapshot);
    const apply = buildTeleportStorageApplyScript(sampleSnapshot);
    expect(init).toContain('"origin":"https://example.com"');
    expect(init).toContain('__slicc_teleport_storage_applied__');
    expect(apply).toContain('Teleport storage origin mismatch');
    expect(apply).toContain('"a":"1"');
  });

  it('detects diagnostic-worthy callback URLs', () => {
    expect(shouldCaptureTeleportDiagnostics('https://idp/callback')).toBe(true);
    expect(shouldCaptureTeleportDiagnostics('https://idp/authorize/resume')).toBe(true);
    expect(shouldCaptureTeleportDiagnostics('https://idp/error')).toBe(true);
    expect(shouldCaptureTeleportDiagnostics('https://app.example/home')).toBe(false);
  });
});

describe('teleport-storage browser helpers', () => {
  it('parses a storage snapshot from evaluate JSON', async () => {
    const browser = {
      evaluate: vi.fn().mockResolvedValue(JSON.stringify(sampleSnapshot)),
      sendCDP: vi.fn(),
      attachToPage: vi.fn(),
    };
    await expect(captureTeleportStorageSnapshot(browser, 'leader')).resolves.toEqual(
      sampleSnapshot
    );
  });

  it('returns empty storage when evaluate is non-string or unparseable', async () => {
    const browser = {
      evaluate: vi.fn().mockResolvedValue(42),
      sendCDP: vi.fn(),
      attachToPage: vi.fn(),
    };
    await expect(captureTeleportStorageSnapshot(browser, 'follower')).resolves.toEqual(
      EMPTY_TELEPORT_STORAGE
    );

    browser.evaluate.mockResolvedValue('{not-json');
    await expect(captureTeleportStorageSnapshot(browser, 'follower')).resolves.toEqual(
      EMPTY_TELEPORT_STORAGE
    );
  });

  it('skips apply and init when the snapshot has no entries', async () => {
    const browser = {
      evaluate: vi.fn(),
      sendCDP: vi.fn(),
      attachToPage: vi.fn(),
    };
    await applyTeleportStorageSnapshot(browser, EMPTY_TELEPORT_STORAGE, 'leader');
    await expect(
      installTeleportStorageInitScript(browser, EMPTY_TELEPORT_STORAGE, 't1', 'leader')
    ).resolves.toBeNull();
    expect(browser.evaluate).not.toHaveBeenCalled();
    expect(browser.sendCDP).not.toHaveBeenCalled();
  });

  it('applies storage and installs a removable init script', async () => {
    const browser = {
      evaluate: vi.fn().mockResolvedValue('{"ok":true}'),
      sendCDP: vi.fn().mockResolvedValue({ identifier: 'script-1' }),
      attachToPage: vi.fn().mockResolvedValue('session'),
    };

    await applyTeleportStorageSnapshot(browser, sampleSnapshot, 'follower');
    expect(browser.evaluate).toHaveBeenCalledOnce();

    const remove = await installTeleportStorageInitScript(
      browser,
      sampleSnapshot,
      'target-1',
      'follower'
    );
    expect(browser.sendCDP).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', {
      source: expect.stringContaining('https://example.com'),
    });
    expect(remove).toBeTypeOf('function');

    await remove?.();
    expect(browser.attachToPage).toHaveBeenCalledWith('target-1');
    expect(browser.sendCDP).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: 'script-1',
    });
  });

  it('captures page diagnostics from evaluate JSON', async () => {
    const browser = {
      evaluate: vi.fn().mockResolvedValue(
        JSON.stringify({
          url: 'https://example.com/callback',
          title: 'Done',
          bodySnippet: 'ok',
        })
      ),
      sendCDP: vi.fn(),
      attachToPage: vi.fn(),
    };
    await expect(captureTeleportPageDiagnostics(browser)).resolves.toEqual({
      url: 'https://example.com/callback',
      title: 'Done',
      bodySnippet: 'ok',
    });
  });
});
