/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Mock @ai-ecoverse/cherry
let mountSliccSpy: Mock<
  (options: {
    iframe?: HTMLIFrameElement;
    joinToken: string;
    uiOnly?: boolean;
    sliccOrigin: string;
    capabilities: { navigate: boolean; screenshot: 'html2canvas' | 'none'; openUrl: boolean };
    features: Record<string, boolean>;
  }) => { iframe: HTMLIFrameElement; emitHostEvent: Mock; destroy: Mock }
>;
let destroySpy: Mock;

vi.mock('@ai-ecoverse/cherry', () => {
  destroySpy = vi.fn();
  mountSliccSpy = vi.fn((options) => ({
    iframe: options.iframe ?? ({} as HTMLIFrameElement),
    emitHostEvent: vi.fn(),
    destroy: destroySpy,
  }));
  return { mountSlicc: mountSliccSpy };
});

// Mock @ai-ecoverse/spoon (benign registration — just no-op the import)
vi.mock('@ai-ecoverse/spoon', () => ({}));

describe('cherry-sidebar-main', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    // Simulate the SW having plumbed the trusted tray origin into MAIN (see
    // plumbTrustedOrigin in cherry-sidebar-sw). Without it, onJoinUrl fails
    // closed. Set as a plain writable property so tests can reset it.
    (window as { __sliccCherryTrustedOrigin?: string }).__sliccCherryTrustedOrigin =
      'https://www.sliccy.ai';
    // Import module once at the top, which registers the global
    await import('../src/cherry-sidebar-main.js');
  });

  afterEach(() => {
    // Unmount if mounted, but don't delete the global
    const ctrl = (globalThis as { __sliccCherrySidebar?: { unmount: () => void } })
      .__sliccCherrySidebar;
    if (ctrl) {
      ctrl.unmount();
    }
    (window as { __sliccCherryTrustedOrigin?: string }).__sliccCherryTrustedOrigin = undefined;
    document.body.innerHTML = '';
  });

  it('registers a global controller without mounting on import (side-effect-free)', () => {
    expect(mountSliccSpy).not.toHaveBeenCalled();
    expect(document.querySelector('slicc-launcher')).toBeNull();
    expect(
      typeof (globalThis as { __sliccCherrySidebar?: { mount?: unknown } }).__sliccCherrySidebar
        ?.mount
    ).toBe('function');
  });

  it('mount() adds an open launcher and, on joinUrl event, calls mountSlicc with iframe+uiOnly', () => {
    const ctrl = (globalThis as { __sliccCherrySidebar?: { mount: () => void } })
      .__sliccCherrySidebar;
    if (!ctrl) throw new Error('Controller not registered');
    ctrl.mount();
    const launcher = document.querySelector('slicc-launcher') as HTMLElement & {
      managedIframe: HTMLIFrameElement;
    };
    expect(launcher).not.toBeNull();
    expect(launcher.hasAttribute('open')).toBe(true);
    expect(launcher.hasAttribute('managed')).toBe(true);
    // dispatch the relay's joinUrl event
    window.dispatchEvent(
      new CustomEvent('slicc:cherry-joinurl', {
        detail: { joinUrl: 'https://www.sliccy.ai/join/t.s' },
      })
    );
    expect(mountSliccSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        iframe: launcher.managedIframe,
        joinToken: 'https://www.sliccy.ai/join/t.s',
        uiOnly: true,
        capabilities: { navigate: false, screenshot: 'none', openUrl: false },
        // chat-focused contract — lock the FULL set so a regression fails:
        features: {
          terminal: false,
          files: false,
          memory: false,
          browser: false,
          newSprinkle: false,
          monitor: false,
          modelPicker: true,
          history: true,
          nav: true,
        },
      })
    );
  });

  it('IGNORES a joinUrl whose origin is not the trusted SLICC origin (page-forged event)', () => {
    const ctrl = (globalThis as { __sliccCherrySidebar?: { mount: () => void } })
      .__sliccCherrySidebar;
    if (!ctrl) throw new Error('Controller not registered');
    ctrl.mount();
    // A hostile host page forges the CustomEvent with an attacker-controlled tray.
    window.dispatchEvent(
      new CustomEvent('slicc:cherry-joinurl', {
        detail: { joinUrl: 'https://attacker.example/join/evil.token' },
      })
    );
    // mountSlicc must NOT be called — the follower must never connect to an
    // off-origin tray (that would leak the user's chat/paste to the attacker).
    expect(mountSliccSpy).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the SW has not plumbed a trusted origin (rejects any joinUrl)', () => {
    // Simulate the SW not having plumbed a trusted origin yet.
    (window as { __sliccCherryTrustedOrigin?: string }).__sliccCherryTrustedOrigin = undefined;
    const ctrl = (globalThis as { __sliccCherrySidebar?: { mount: () => void } })
      .__sliccCherrySidebar;
    if (!ctrl) throw new Error('Controller not registered');
    ctrl.mount();
    // Even a well-formed same-origin joinUrl is rejected until the SW plumbs the
    // trusted origin over the unforgeable executeScript channel.
    window.dispatchEvent(
      new CustomEvent('slicc:cherry-joinurl', {
        detail: { joinUrl: 'https://www.sliccy.ai/join/t.s' },
      })
    );
    expect(mountSliccSpy).not.toHaveBeenCalled();
  });

  it('close event tears down (dispose + remove launcher + dispatch slicc:cherry-close)', () => {
    const closeSpy = vi.fn();
    window.addEventListener('slicc:cherry-close', closeSpy);
    const ctrl = (globalThis as { __sliccCherrySidebar?: { mount: () => void } })
      .__sliccCherrySidebar;
    if (!ctrl) throw new Error('Controller not registered');
    ctrl.mount();
    // Trigger joinUrl so handle is created
    window.dispatchEvent(
      new CustomEvent('slicc:cherry-joinurl', {
        detail: { joinUrl: 'https://www.sliccy.ai/join/t.s' },
      })
    );
    document
      .querySelector('slicc-launcher')!
      .dispatchEvent(new CustomEvent('slicc-launcher-close', { bubbles: true, composed: true }));
    expect(destroySpy).toHaveBeenCalled(); // mountSlicc handle disposed
    expect(document.querySelector('slicc-launcher')).toBeNull();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('mount() is idempotent (second call does not create a second launcher)', () => {
    const ctrl = (globalThis as { __sliccCherrySidebar?: { mount: () => void } })
      .__sliccCherrySidebar;
    if (!ctrl) throw new Error('Controller not registered');
    ctrl.mount();
    ctrl.mount();
    expect(document.querySelectorAll('slicc-launcher').length).toBe(1);
  });

  it('slicc:cherry-teardown unmounts', () => {
    const ctrl = (globalThis as { __sliccCherrySidebar?: { mount: () => void } })
      .__sliccCherrySidebar;
    if (!ctrl) throw new Error('Controller not registered');
    ctrl.mount();
    window.dispatchEvent(new CustomEvent('slicc:cherry-teardown'));
    expect(document.querySelector('slicc-launcher')).toBeNull();
  });
});
