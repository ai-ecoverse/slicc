// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mountSevenBanner,
  SEVEN_BANNER_DISMISSED_KEY,
  SEVEN_BANNER_ID,
  SEVEN_IN_PLACE_PATH,
  sevenInPlaceHref,
} from '../../../src/ui/wc/wc-seven-banner.js';

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

  it('says SLICC 7 is at seven.sliccy.ai between the nav and the shell', () => {
    const { appCol, nav, main } = shell();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      storage: memoryStorage(),
    });
    expect(banner?.id).toBe(SEVEN_BANNER_ID);
    expect(banner?.textContent).toContain('SLICC 7 is at seven.sliccy.ai.');
    expect(banner?.textContent).toContain('Export your profile');
    expect(banner?.querySelector('a')?.getAttribute('href')).toBe('https://seven.sliccy.ai');
    expect([...appCol.children]).toEqual([nav, banner, main]);
  });

  it('opens the export from its button', () => {
    const { appCol, main } = shell();
    const onExport = vi.fn();
    const banner = mountSevenBanner(document, appCol, main, { onExport, storage: memoryStorage() });
    banner?.querySelector<HTMLButtonElement>('.wcsev__export')?.click();
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('remembers a dismissal and stays away afterwards', () => {
    const { appCol, main } = shell();
    const storage = memoryStorage();
    const banner = mountSevenBanner(document, appCol, main, { onExport: vi.fn(), storage });
    banner?.querySelector<HTMLButtonElement>('.wcsev__close')?.click();
    expect(document.getElementById(SEVEN_BANNER_ID)).toBeNull();
    expect(storage.setItem).toHaveBeenCalledWith(SEVEN_BANNER_DISMISSED_KEY, '1');
    expect(mountSevenBanner(document, appCol, main, { onExport: vi.fn(), storage })).toBeNull();
  });

  it('is idempotent and appends when the anchor is elsewhere', () => {
    const { appCol } = shell();
    const stray = document.createElement('div');
    const first = mountSevenBanner(document, appCol, stray, {
      onExport: vi.fn(),
      storage: memoryStorage(),
    });
    expect(appCol.lastElementChild).toBe(first);
    expect(
      mountSevenBanner(document, appCol, null, { onExport: vi.fn(), storage: memoryStorage() })
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
    const banner = mountSevenBanner(document, appCol, main, { onExport: vi.fn(), storage: broken });
    expect(banner).not.toBeNull();
    banner?.querySelector<HTMLButtonElement>('.wcsev__close')?.click();
    expect(document.getElementById(SEVEN_BANNER_ID)).toBeNull();
    const again = mountSevenBanner(document, appCol, main, { onExport: vi.fn(), storage: null });
    expect(again).not.toBeNull();
    again?.remove();
    expect(mountSevenBanner(document, appCol, main, { onExport: vi.fn() })).not.toBeNull();
  });

  it('offers Move to seven in this browser, opening /7/ in this tab, when given a move href', () => {
    const { appCol, main } = shell();
    const onExport = vi.fn();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport,
      moveHref: SEVEN_IN_PLACE_PATH,
      storage: memoryStorage(),
    });
    const move = banner?.querySelector<HTMLAnchorElement>('a.wcsev__move');
    expect(move?.textContent).toBe('Move to seven in this browser');
    expect(move?.getAttribute('href')).toBe('/7/');
    expect(move?.target).toBe('');
    banner?.querySelector<HTMLButtonElement>('button.wcsev__export')?.click();
    expect(onExport).toHaveBeenCalledOnce();
    expect(banner?.textContent).toContain('SLICC 7 is at seven.sliccy.ai.');
  });

  it('keeps the visual order the tab order: text, move, export, dismiss', () => {
    const { appCol, main } = shell();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      moveHref: SEVEN_IN_PLACE_PATH,
      storage: memoryStorage(),
    });
    expect([...banner!.children].map((c) => c.className)).toEqual([
      'wcsev__text',
      'wcsev__export wcsev__move',
      'wcsev__export wcsev__export--secondary',
      'wcsev__close',
    ]);

    expect(document.getElementById('slicc-seven-banner-style')?.textContent).not.toMatch(
      /\border:/
    );
  });

  it('has no move action without a move href', () => {
    const { appCol, main } = shell();
    const banner = mountSevenBanner(document, appCol, main, {
      onExport: vi.fn(),
      moveHref: null,
      storage: memoryStorage(),
    });
    expect(banner?.querySelector('.wcsev__move')).toBeNull();
  });
});

describe('sevenInPlaceHref', () => {
  it('is /7/ on www only', () => {
    expect(sevenInPlaceHref('https://www.sliccy.ai')).toBe('/7/');
    expect(sevenInPlaceHref('http://localhost:5710')).toBeNull();
    expect(sevenInPlaceHref('https://seven.sliccy.ai')).toBeNull();
    expect(sevenInPlaceHref('chrome-extension://abc')).toBeNull();
  });
});
