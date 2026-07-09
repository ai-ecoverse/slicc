// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderBootRecoveryScreen } from '../../../src/ui/boot/recovery-screen.js';

describe('renderBootRecoveryScreen', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

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
