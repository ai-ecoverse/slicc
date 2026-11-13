// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mountSevenBanner,
  SEVEN_BANNER_DISMISSED_KEY,
  SEVEN_BANNER_ID,
  SEVEN_UPGRADE_URL,
  upgradesInPlace,
} from '../../../src/ui/wc/wc-seven-banner.js';

const LOCAL = 'http://localhost:5710';
const WWW = 'https://www.sliccy.ai';

function memoryStorage(initial: { [key: string]: string } = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
  };
}

function shell(): { appCol: HTMLElement; nav: HTMLElement; main: HTMLElement } {
  const appCol = document.createElement('div');
  const nav = document.createElement('nav');
  const main = document.createElement('slicc-shell');
  appCol.append(nav, main);
  document.body.append(appCol);
  return { appCol, nav, main };
}

describe('mountSevenBanner', () => {
  afterEach(() => document.body.replaceChildren());

  it('invites you to try the upgrade at www.sliccy.ai/7 between the nav and the shell', () => {
    const { appCol, nav, main } = shell();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      origin: LOCAL,
      storage: memoryStorage(),
    });
    expect(banner?.id).toBe(SEVEN_BANNER_ID);
    expect(banner?.textContent).toContain('SLICC 7 is here.');
    expect(banner?.textContent).toContain('Export your profile');
    const upgrade = banner?.querySelector<HTMLAnchorElement>('a.wcsev__upgrade');
    expect(upgrade?.textContent).toBe('Try the upgrade');
    expect(upgrade?.getAttribute('href')).toBe('https://www.sliccy.ai/7/');
    expect(SEVEN_UPGRADE_URL).toBe('https://www.sliccy.ai/7/');
    expect([...appCol.children]).toEqual([nav, banner, main]);
  });

  it('opens the export from its button', () => {
    const { appCol, main } = shell();
    const onExport = vi.fn();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport,
      origin: LOCAL,
      storage: memoryStorage(),
    });
    banner?.querySelector<HTMLButtonElement>('button.wcsev__export')?.click();
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('remembers a dismissal and stays away afterwards', () => {
    const { appCol, main } = shell();
    const storage = memoryStorage();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      origin: LOCAL,
      storage,
    });
    banner?.querySelector<HTMLButtonElement>('.wcsev__close')?.click();
    expect(document.getElementById(SEVEN_BANNER_ID)).toBeNull();
    expect(storage.setItem).toHaveBeenCalledWith(SEVEN_BANNER_DISMISSED_KEY, '1');
    expect(
      mountSevenBanner(document, appCol, main, { onExport: vi.fn(), origin: LOCAL, storage })
    ).toBeNull();
  });

  it('is idempotent and appends when the anchor is elsewhere', () => {
    const { appCol } = shell();
    const stray = document.createElement('div');
    const first = mountSevenBanner(document, appCol, stray, {
      onExport: vi.fn(),
      origin: LOCAL,
      storage: memoryStorage(),
    });
    expect(appCol.lastElementChild).toBe(first);
    expect(
      mountSevenBanner(document, appCol, null, {
        onExport: vi.fn(),
        origin: LOCAL,
        storage: memoryStorage(),
      })
    ).toBeNull();
  });

  it('survives storage that throws, and defaults to localStorage', () => {
    const { appCol, main } = shell();
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      origin: LOCAL,
      storage: broken,
    });
    expect(banner).not.toBeNull();
    banner?.querySelector<HTMLButtonElement>('.wcsev__close')?.click();
    expect(document.getElementById(SEVEN_BANNER_ID)).toBeNull();
    const again = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      origin: LOCAL,
      storage: null,
    });
    expect(again).not.toBeNull();
    again?.remove();
    expect(
      mountSevenBanner(document, appCol, main, { onExport: vi.fn(), origin: LOCAL })
    ).not.toBeNull();
  });

  it('opens the upgrade in this tab on www, where seven moves the profile in place', () => {
    const { appCol, main } = shell();
    const onExport = vi.fn();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport,
      origin: WWW,
      storage: memoryStorage(),
    });
    const upgrade = banner?.querySelector<HTMLAnchorElement>('a.wcsev__upgrade');
    expect(upgrade?.getAttribute('href')).toBe('https://www.sliccy.ai/7/');
    expect(upgrade?.target).toBe('');
    banner?.querySelector<HTMLButtonElement>('button.wcsev__export')?.click();
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('opens the upgrade in a new tab off www', () => {
    const { appCol, main } = shell();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      origin: LOCAL,
      storage: memoryStorage(),
    });
    const upgrade = banner?.querySelector<HTMLAnchorElement>('a.wcsev__upgrade');
    expect(upgrade?.target).toBe('_blank');
    expect(upgrade?.rel).toBe('noopener');
  });

  it('does not stay hidden by a dismissal of the earlier seven.sliccy.ai banner', () => {
    const { appCol, main } = shell();
    const storage = memoryStorage({ 'slicc-seven-banner-dismissed': '1' });
    expect(
      mountSevenBanner(document, appCol, main, { onExport: vi.fn(), origin: LOCAL, storage })
    ).not.toBeNull();
  });

  it('keeps the visual order the tab order: text, upgrade, export, dismiss', () => {
    const { appCol, main } = shell();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      origin: WWW,
      storage: memoryStorage(),
    });
    expect([...banner!.children].map((c) => c.className)).toEqual([
      'wcsev__text',
      'wcsev__export wcsev__upgrade',
      'wcsev__export wcsev__export--secondary',
      'wcsev__close',
    ]);
    // No CSS `order` anywhere, so narrow layouts can't reorder what Tab visits.
    expect(document.getElementById('slicc-seven-banner-style')?.textContent).not.toMatch(
      /\border:/
    );
  });
});

describe('upgradesInPlace', () => {
  it('is true on www only', () => {
    expect(upgradesInPlace('https://www.sliccy.ai')).toBe(true);
    expect(upgradesInPlace('http://localhost:5710')).toBe(false);
    expect(upgradesInPlace('https://seven.sliccy.ai')).toBe(false);
    expect(upgradesInPlace('chrome-extension://abc')).toBe(false);
  });
});
