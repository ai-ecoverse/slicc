// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  removeBootStage,
  removeBootStallOverlay,
  showBootStage,
  showBootStallOverlay,
} from '../../../src/ui/boot/boot-stall-overlay.js';

describe('boot stall overlay', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('renders once and updates the elapsed time on repeat calls', () => {
    showBootStallOverlay(document, { elapsedMs: 30_000 });
    const overlay = document.getElementById('slicc-boot-stall-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toContain('30s');
    expect(overlay?.textContent).toContain('your data is untouched');

    showBootStallOverlay(document, { elapsedMs: 90_000 });

    expect(document.querySelectorAll('#slicc-boot-stall-overlay')).toHaveLength(1);
    expect(document.getElementById('slicc-boot-stall-overlay')?.textContent).toContain('90s');
  });

  it('does not replace the app DOM — the wired shell must survive a stall', () => {
    const shell = document.createElement('main');
    shell.id = 'app';
    document.body.appendChild(shell);
    showBootStallOverlay(document, { elapsedMs: 30_000 });
    expect(document.getElementById('app')).toBe(shell);
  });

  it('offers a plain Reload and no destructive action', () => {
    const reload = vi.fn();
    showBootStallOverlay(document, { elapsedMs: 30_000 }, { reload });
    const buttons = [...document.querySelectorAll('#slicc-boot-stall-overlay button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reload']);
    (buttons[0] as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('removeBootStallOverlay clears it and is safe when never shown', () => {
    removeBootStallOverlay(document);
    showBootStallOverlay(document, { elapsedMs: 30_000 });
    removeBootStallOverlay(document);
    expect(document.getElementById('slicc-boot-stall-overlay')).toBeNull();
  });

  it('names the latest boot stage on the stall banner', () => {
    showBootStallOverlay(document, { elapsedMs: 30_000, stage: 'mounts-restored' });
    expect(document.getElementById('slicc-boot-stall-overlay')?.textContent).toContain(
      'mounts-restored'
    );
  });

  it('shows the live boot stage and drops it when the stall banner takes over', () => {
    showBootStage(document, 'orchestrator-ready');
    expect(document.getElementById('slicc-boot-stage')?.textContent).toContain(
      'orchestrator-ready'
    );
    showBootStage(document, 'cone-bootstrapped');
    expect(document.querySelectorAll('#slicc-boot-stage')).toHaveLength(1);
    expect(document.getElementById('slicc-boot-stage')?.textContent).toContain('cone-bootstrapped');
    showBootStallOverlay(document, { elapsedMs: 1_000, stage: 'cone-bootstrapped' });
    expect(document.getElementById('slicc-boot-stage')).toBeNull();

    showBootStage(document, 'cone-bootstrapped');
    expect(document.getElementById('slicc-boot-stage')).toBeNull();
    removeBootStage(document);
  });
});
