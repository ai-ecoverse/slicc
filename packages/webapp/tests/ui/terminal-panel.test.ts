// @vitest-environment jsdom
/**
 * DOM tests for `TerminalPanel` — the embedded panel that hosts an
 * xterm.js terminal and a preview pane. The `WasmShell` /
 * `RemoteTerminalView` dependencies are stubbed via the structural
 * `MountedTerminalShell` interface the panel already exposes for
 * dual-mode hosting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPanel } from '../../src/ui/terminal-panel.js';

function makeMountStub(opts: { withPreview?: boolean } = {}): {
  shell: {
    mount: ReturnType<typeof vi.fn>;
    refit: ReturnType<typeof vi.fn>;
    clearTerminal: ReturnType<typeof vi.fn>;
    executeCommandInTerminal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    setPreviewStateListener: ReturnType<typeof vi.fn>;
  };
  previewListener: { current: ((hasPreview: boolean) => void) | null };
} {
  const previewListener = { current: null as ((hasPreview: boolean) => void) | null };
  const shell = {
    mount: vi.fn(async (mountEl: HTMLElement) => {
      const terminalHost = document.createElement('div');
      terminalHost.className = 'terminal-panel__terminal-host';
      mountEl.appendChild(terminalHost);
      if (opts.withPreview !== false) {
        const previewHost = document.createElement('div');
        previewHost.className = 'terminal-panel__preview';
        mountEl.appendChild(previewHost);
      }
    }),
    refit: vi.fn(),
    clearTerminal: vi.fn(),
    executeCommandInTerminal: vi.fn(async () => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    })),
    dispose: vi.fn(),
    setPreviewStateListener: vi.fn((listener: ((hasPreview: boolean) => void) | null) => {
      previewListener.current = listener;
    }),
  };
  return { shell, previewListener };
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('TerminalPanel — initial render', () => {
  it('renders the header, preview button, and terminal/preview views', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    // biome-ignore lint/correctness/noUnusedVariables: side-effect render under test
    const panel = new TerminalPanel(container);
    expect(container.classList.contains('terminal-panel')).toBe(true);
    expect(container.querySelector('.file-browser__header')).not.toBeNull();
    expect(container.querySelectorAll('.terminal-panel__view')).toHaveLength(2);
    expect(container.querySelector('.terminal-panel__empty-state')).not.toBeNull();
    const previewBtn = container.querySelector(
      'button[aria-label="Toggle preview"]'
    ) as HTMLButtonElement;
    expect(previewBtn).not.toBeNull();
    expect(previewBtn.disabled).toBe(true);
    void panel;
  });

  it('mounts a Clear-Terminal button only when onClearTerminal is provided', () => {
    const c1 = document.createElement('div');
    document.body.appendChild(c1);
    new TerminalPanel(c1);
    expect(c1.querySelector('button[aria-label="Clear Terminal"]')).toBeNull();
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const onClearTerminal = vi.fn();
    new TerminalPanel(c2, { onClearTerminal });
    const clearBtn = c2.querySelector('button[aria-label="Clear Terminal"]') as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    clearBtn.click();
    clearBtn.click();
    expect(onClearTerminal).toHaveBeenCalledTimes(2);
  });

  it('getBodyElement() returns the panel container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    expect(panel.getBodyElement()).toBe(container);
  });

  it('runCommand without a mounted shell returns exit code 1 + stderr message', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const result = await panel.runCommand('echo hi');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unavailable/);
  });

  it('clearTerminal / refit / dispose are safe before a shell is mounted', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    expect(() => panel.clearTerminal()).not.toThrow();
    expect(() => panel.refit()).not.toThrow();
    expect(() => panel.dispose()).not.toThrow();
    // dispose() empties the container.
    expect(container.innerHTML).toBe('');
  });
});

describe('TerminalPanel — mountShell (WasmShell)', () => {
  it('relocates the terminal/preview hosts and registers a preview listener', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell, previewListener } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    expect(shell.mount).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.terminal-panel__terminal-host')).not.toBeNull();
    expect(container.querySelector('.terminal-panel__preview')).not.toBeNull();
    expect(typeof previewListener.current).toBe('function');
  });

  it('throws when the shell does not produce both expected host elements', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell } = makeMountStub({ withPreview: false });
    await expect(panel.mountShell(shell as unknown as never)).rejects.toThrow(
      /did not create expected hosts/
    );
  });

  it('routes clearTerminal/refit/runCommand to the mounted shell', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    panel.clearTerminal();
    panel.refit();
    const result = await panel.runCommand('echo hi');
    expect(shell.clearTerminal).toHaveBeenCalledTimes(1);
    expect(shell.refit).toHaveBeenCalled();
    expect(shell.executeCommandInTerminal).toHaveBeenCalledWith('echo hi');
    expect(result.exitCode).toBe(0);
  });

  it('preview-toggle button is wired to switch views once enabled', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell, previewListener } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    previewListener.current?.(true); // turns the button on AND switches to preview
    const previewBtn = container.querySelector(
      'button[aria-label="Toggle preview"]'
    ) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(false);
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(true);
    // Toggling it back goes to terminal.
    previewBtn.click();
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(false);
    // Toggling it again goes back to preview.
    previewBtn.click();
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(true);
  });

  it('preview-toggle button does nothing when disabled', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    const previewBtn = container.querySelector(
      'button[aria-label="Toggle preview"]'
    ) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
    previewBtn.click();
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(false);
  });

  it('handlePreviewStateChange(false) flips back to the terminal view', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell, previewListener } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    previewListener.current?.(true);
    previewListener.current?.(false);
    const previewBtn = container.querySelector(
      'button[aria-label="Toggle preview"]'
    ) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(false);
  });

  it('runCommand for an imgcat command does NOT force back to the terminal view', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell, previewListener } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    previewListener.current?.(true);
    const previewBtn = container.querySelector(
      'button[aria-label="Toggle preview"]'
    ) as HTMLButtonElement;
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(true);
    await panel.runCommand('imgcat /tmp/x.png');
    // Still on the preview view.
    expect(previewBtn.classList.contains('file-browser__header-btn--active')).toBe(true);
  });

  it('mountShell twice unhooks the prior preview listener', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const first = makeMountStub();
    await panel.mountShell(first.shell as unknown as never);
    const second = makeMountStub();
    await panel.mountShell(second.shell as unknown as never);
    // The first stub's listener was cleared before reassignment.
    expect(first.shell.setPreviewStateListener).toHaveBeenLastCalledWith(null);
  });

  it('dispose() unhooks the preview listener and clears the container', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell } = makeMountStub();
    await panel.mountShell(shell as unknown as never);
    panel.dispose();
    expect(shell.setPreviewStateListener).toHaveBeenLastCalledWith(null);
    expect(shell.dispose).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });
});

describe('TerminalPanel — mountRemoteShell', () => {
  it('mounts a remote view that may not provide a preview host', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const { shell: view, previewListener } = makeMountStub();
    await panel.mountRemoteShell(view as unknown as never);
    expect(view.mount).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.terminal-panel__terminal-host')).not.toBeNull();
    expect(typeof previewListener.current).toBe('function');
  });

  it('throws when the remote mount produces no terminal host', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new TerminalPanel(container);
    const view = {
      mount: vi.fn(async (_el: HTMLElement) => {}),
      refit: vi.fn(),
      clearTerminal: vi.fn(),
      executeCommandInTerminal: vi.fn(),
      dispose: vi.fn(),
      setPreviewStateListener: vi.fn(),
    };
    await expect(panel.mountRemoteShell(view as unknown as never)).rejects.toThrow(
      /did not create expected host/
    );
  });
});
