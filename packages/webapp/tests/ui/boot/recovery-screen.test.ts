// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NUKE_LOCAL_STORAGE_KEYS } from '../../../src/shell/supplemental-commands/nuke-channel.js';
import { renderBootRecoveryScreen } from '../../../src/ui/boot/recovery-screen.js';

describe('renderBootRecoveryScreen', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Map-backed `localStorage` stub — the test env has no real one
   *  (jsdom here is built without `--localstorage-file`). */
  function stubLocalStorage(seed: Record<string, string> = {}): Map<string, string> {
    const store = new Map<string, string>(Object.entries(seed));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
    return store;
  }

  function mount(): HTMLElement {
    const app = document.createElement('div');
    // Seed prior content to prove the screen replaces it.
    app.appendChild(document.createElement('span'));
    document.body.appendChild(app);
    return app;
  }

  function buttonByText(app: HTMLElement, text: string): HTMLButtonElement {
    const btn = [...app.querySelectorAll('button')].find((b) => b.textContent === text);
    expect(btn, `button "${text}" present`).toBeTruthy();
    return btn as HTMLButtonElement;
  }

  it('shows the error message and both recovery buttons', () => {
    const app = mount();
    renderBootRecoveryScreen(app, new Error('kernel boot timed out'), {
      wipe: vi.fn(async () => {}),
      reload: vi.fn(),
    });

    expect(app.querySelector('h1')?.textContent).toBe('Failed to start');
    expect(app.querySelector('p')?.textContent).toBe('kernel boot timed out');
    buttonByText(app, 'Reset local data & reload');
    buttonByText(app, 'Reload');
    // Prior content was replaced.
    expect(app.querySelector('span')).toBeNull();
  });

  it('renders a non-Error argument via String()', () => {
    const app = mount();
    renderBootRecoveryScreen(app, 'plain string failure', { wipe: vi.fn(), reload: vi.fn() });
    expect(app.querySelector('p')?.textContent).toBe('plain string failure');
  });

  it('reset button invokes the wipe then reloads', async () => {
    const app = mount();
    let wipeResolved = false;
    const wipe = vi.fn(async () => {
      await Promise.resolve();
      wipeResolved = true;
    });
    const reload = vi.fn();
    renderBootRecoveryScreen(app, new Error('boom'), { wipe, reload });

    const resetBtn = buttonByText(app, 'Reset local data & reload');
    resetBtn.click();

    // Buttons disabled immediately; reload waits for the wipe.
    expect(resetBtn.disabled).toBe(true);
    expect(buttonByText(app, 'Reload').disabled).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(wipeResolved).toBe(true);
  });

  it('reset button removes every nuke localStorage key after the wipe, before reload', async () => {
    const app = mount();
    const seed = Object.fromEntries(
      [...NUKE_LOCAL_STORAGE_KEYS, 'slicc.keepMe'].map((k) => [k, 'v'])
    );
    const store = stubLocalStorage(seed);

    const wipe = vi.fn(async () => {
      await Promise.resolve();
      // Keys must still be present until the wipe completes.
      for (const key of NUKE_LOCAL_STORAGE_KEYS) expect(store.has(key)).toBe(true);
    });
    let keysGoneAtReload = false;
    const reload = vi.fn(() => {
      // Removal must have happened before reload fires.
      keysGoneAtReload = NUKE_LOCAL_STORAGE_KEYS.every((key) => !store.has(key));
    });
    renderBootRecoveryScreen(app, new Error('boom'), { wipe, reload });

    buttonByText(app, 'Reset local data & reload').click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    for (const key of NUKE_LOCAL_STORAGE_KEYS) expect(store.has(key)).toBe(false);
    expect(keysGoneAtReload).toBe(true);
    // Unrelated keys are left untouched.
    expect(store.get('slicc.keepMe')).toBe('v');
  });

  it('reset button still reloads if localStorage.removeItem throws', async () => {
    const app = mount();
    const removeItem = vi.fn(() => {
      throw new Error('localStorage disabled');
    });
    vi.stubGlobal('localStorage', { removeItem });
    const reload = vi.fn();
    renderBootRecoveryScreen(app, new Error('boom'), { wipe: vi.fn(async () => {}), reload });

    buttonByText(app, 'Reset local data & reload').click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(removeItem).toHaveBeenCalledTimes(NUKE_LOCAL_STORAGE_KEYS.length);
  });

  it('reset button still reloads if the wipe rejects', async () => {
    const app = mount();
    const wipe = vi.fn(async () => {
      throw new Error('wipe failed');
    });
    const reload = vi.fn();
    renderBootRecoveryScreen(app, new Error('boom'), { wipe, reload });

    buttonByText(app, 'Reset local data & reload').click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('plain Reload button reloads without wiping', () => {
    const app = mount();
    const wipe = vi.fn(async () => {});
    const reload = vi.fn();
    renderBootRecoveryScreen(app, new Error('boom'), { wipe, reload });

    buttonByText(app, 'Reload').click();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(wipe).not.toHaveBeenCalled();
  });
});

describe('renderBootRecoveryScreen — browser-wedged variant (#1982)', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mountWedged(deps: { wipe?: () => Promise<void>; reload?: () => void } = {}) {
    const app = document.createElement('div');
    document.body.appendChild(app);
    renderBootRecoveryScreen(app, new Error('Kernel worker did not signal ready within 30000ms'), {
      wipe: deps.wipe ?? vi.fn(async () => {}),
      reload: deps.reload ?? vi.fn(),
      verdict: 'browser-wedged',
    });
    return app;
  }

  it('leads with the browser restart, not the failure', () => {
    const app = mountWedged();
    expect(app.querySelector('h1')?.textContent).toBe('Your browser needs a restart');
    // The explanation names the fix and protects the data.
    const text = app.textContent ?? '';
    expect(text).toContain('Quit the browser completely');
    expect(text).toContain('resetting it will not fix this');
  });

  it('orders Reload first and demotes (but keeps) the destructive reset', () => {
    const app = mountWedged();
    const buttons = [...app.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reload', 'Reset local data & reload']);
    // Demoted: the reset is no longer the filled negative action.
    expect(buttons[1]?.dataset['variant']).toBe('demoted');
  });

  it('the demoted reset still wipes and reloads when explicitly chosen', async () => {
    const wipe = vi.fn(async () => {});
    const reload = vi.fn();
    const app = mountWedged({ wipe, reload });
    const reset = [...app.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reset local data & reload'
    ) as HTMLButtonElement;
    reset.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it('the triage re-render never replaces a wipe in progress', async () => {
    let releaseWipe: () => void = () => {};
    const wipe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWipe = resolve;
        })
    );
    const reload = vi.fn();
    const app = document.createElement('div');
    document.body.appendChild(app);
    const err = new Error('Kernel worker did not signal ready within 30000ms');
    renderBootRecoveryScreen(app, err, { wipe, reload });
    const reset = [...app.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reset local data & reload'
    ) as HTMLButtonElement;
    reset.click();
    expect(reset.textContent).toBe('Resetting…');

    // The (late) triage verdict arrives mid-wipe: the re-render is a no-op.
    renderBootRecoveryScreen(app, err, { wipe, reload, verdict: 'browser-wedged' });
    expect(app.querySelector('h1')?.textContent).toBe('Failed to start');
    expect([...app.querySelectorAll('button')][0]?.textContent).toBe('Resetting…');

    releaseWipe();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
