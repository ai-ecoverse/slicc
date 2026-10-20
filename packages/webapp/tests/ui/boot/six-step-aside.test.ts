/**
 * Six steps aside on www once seven has upgraded this browser (slicc#4051):
 * the page goes to `/os/` from any six route and never registers
 * `/preview-sw.js` or `/llm-proxy-sw.js`. Only on the hosted origin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupSwRegistration } from '../../../src/ui/boot/setup-sw-registration.js';
import {
  SEVEN_OS_URL_PATH,
  SIX_UPGRADED_KEY,
  SIX_UPGRADED_VALUE,
  shouldStepAsideForSeven,
  stepAsideForSeven,
} from '../../../src/ui/boot/six-step-aside.js';

const WWW = 'https://www.sliccy.ai';

function win(origin: string, marker: string | null, path = '/') {
  const replace = vi.fn();
  return {
    replace,
    win: {
      location: { origin, href: `${origin}${path}`, replace },
      localStorage: { getItem: (k: string) => (k === SIX_UPGRADED_KEY ? marker : null) },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldStepAsideForSeven', () => {
  it('is true on www once seven set slicc-os.six = upgraded', () => {
    expect(SIX_UPGRADED_KEY).toBe('slicc-os.six');
    expect(SIX_UPGRADED_VALUE).toBe('upgraded');
    expect(shouldStepAsideForSeven(win(WWW, 'upgraded').win)).toBe(true);
  });

  it('is false before the upgrade, or with any other value', () => {
    expect(shouldStepAsideForSeven(win(WWW, null).win)).toBe(false);
    expect(shouldStepAsideForSeven(win(WWW, 'upgrading').win)).toBe(false);
  });

  it('is false off the hosted origin: the CLI and the extension keep their export', () => {
    expect(shouldStepAsideForSeven(win('http://localhost:5710', 'upgraded').win)).toBe(false);
    expect(shouldStepAsideForSeven(win('chrome-extension://abc', 'upgraded').win)).toBe(false);
    expect(shouldStepAsideForSeven(win('https://seven.sliccy.ai', 'upgraded').win)).toBe(false);
  });

  it('is false when storage throws', () => {
    const { win: w } = win(WWW, null);
    w.localStorage.getItem = () => {
      throw new Error('denied');
    };
    expect(shouldStepAsideForSeven(w)).toBe(false);
  });
});

describe('stepAsideForSeven', () => {
  it.each(['/', '/join/tok-123', '/controller/tok', '/?slicc=leader', '/some/spa/route'])(
    'replaces %s with /os/',
    (path) => {
      const { win: w, replace } = win(WWW, 'upgraded', path);
      expect(stepAsideForSeven(w)).toBe(true);
      expect(replace).toHaveBeenCalledWith(SEVEN_OS_URL_PATH);
    }
  );

  it('steps aside later when seven sets the marker from another tab', () => {
    let marker: string | null = null;
    let listener: ((event: { key: string | null }) => void) | undefined;
    const replace = vi.fn();
    const w = {
      location: { origin: WWW, replace },
      localStorage: { getItem: () => marker },
      addEventListener: (_type: 'storage', l: (event: { key: string | null }) => void) => {
        listener = l;
      },
    };
    expect(stepAsideForSeven(w)).toBe(false);
    listener!({ key: 'something-else' });
    marker = SIX_UPGRADED_VALUE;
    listener!({ key: 'unrelated' });
    expect(replace).not.toHaveBeenCalled();
    listener!({ key: SIX_UPGRADED_KEY });
    expect(replace).toHaveBeenCalledWith(SEVEN_OS_URL_PATH);
  });

  it('does not watch off the hosted origin', () => {
    const addEventListener = vi.fn();
    stepAsideForSeven({
      location: { origin: 'http://localhost:5710', replace: vi.fn() },
      localStorage: { getItem: () => null },
      addEventListener,
    });
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('leaves the page alone before the upgrade', () => {
    const { win: w, replace } = win(WWW, null);
    expect(stepAsideForSeven(w)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('setupSwRegistration after the upgrade', () => {
  function stubBrowser(origin: string, marker: string | null, search = '') {
    const register = vi.fn(async () => ({}));
    const getRegistrations = vi.fn(async () => []);
    const { win: w } = win(origin, marker);
    vi.stubGlobal('window', { ...w, location: { ...w.location, search } });
    vi.stubGlobal('navigator', {
      serviceWorker: { register, getRegistrations, controller: {}, addEventListener: () => {} },
    });
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    vi.stubGlobal('location', { reload: vi.fn() });
    return { register, getRegistrations };
  }

  it('registers neither /preview-sw.js nor /llm-proxy-sw.js on www', async () => {
    const { register } = stubBrowser(WWW, 'upgraded');
    expect(await setupSwRegistration()).toBe('ready');
    expect(register).not.toHaveBeenCalled();
  });

  it("does not unregister seven's service worker from the connect surface either", async () => {
    const { register, getRegistrations } = stubBrowser(WWW, 'upgraded', '?connect=1');
    expect(await setupSwRegistration()).toBe('ready');
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('still registers both before the upgrade', async () => {
    const { register } = stubBrowser(WWW, null);
    await setupSwRegistration();
    expect(register.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      '/preview-sw.js',
      '/llm-proxy-sw.js',
    ]);
  });
});

describe('ui/main.ts wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(here, '..', '..', '..', 'src', 'ui', 'main.ts'), 'utf8');

  it('steps aside first thing, before service workers and every float', () => {
    const idx = main.search(/^ {2}if \(stepAsideForSeven\(window\)\) return;$/m);
    expect(idx).toBeGreaterThan(main.indexOf('async function main()'));
    for (const later of [
      'setupPreloadErrorReload();',
      'await setupSwRegistration(',
      'bootFollowerFloat(app',
      'mountConnectSurface(app',
      'bootLeaderFloat(app',
      'mountWcUiPreview(app',
    ]) {
      const at = main.indexOf(later);
      expect(at, later).toBeGreaterThan(-1);
      expect(idx, later).toBeLessThan(at);
    }
  });
});
