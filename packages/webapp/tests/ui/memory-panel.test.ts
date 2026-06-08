// @vitest-environment jsdom
/**
 * Tests for `MemoryPanel` — the panel-side viewer that surfaces the
 * `/shared/CLAUDE.md` global memory plus the active scoop/cone memory
 * file. The orchestrator dependency is mocked with the minimum surface
 * `MemoryPanel` actually calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryPanel } from '../../src/ui/memory-panel.js';

type OrchestratorMock = {
  getGlobalMemory: ReturnType<typeof vi.fn>;
  getScoopContext: ReturnType<typeof vi.fn>;
  getScoop: ReturnType<typeof vi.fn>;
};

function makeOrchestrator(overrides: Partial<OrchestratorMock> = {}): OrchestratorMock {
  return {
    getGlobalMemory: vi.fn(async () => '# Shared memory body'),
    getScoopContext: vi.fn(() => null),
    getScoop: vi.fn(() => null),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryPanel — initial render', () => {
  it('mounts `.memory-panel__body` inside the container and clears prior content', () => {
    const container = document.createElement('div');
    container.appendChild(document.createElement('span'));
    document.body.appendChild(container);
    // biome-ignore lint/correctness/noUnusedVariables: ctor side-effects under test
    const panel = new MemoryPanel(container);
    expect(container.classList.contains('memory-panel')).toBe(true);
    expect(container.querySelector('.memory-panel__body')).not.toBeNull();
    expect(container.querySelector('span')).toBeNull();
    void panel;
  });
});

describe('MemoryPanel — refresh()', () => {
  it('returns early when no orchestrator is set', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    await panel.refresh();
    expect(container.querySelector('.memory-panel__section')).toBeNull();
  });

  it('renders the global memory section when present', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator();
    panel.setOrchestrator(orch as unknown as never);
    await vi.waitFor(() => {
      expect(container.querySelector('.memory-panel__section')).not.toBeNull();
    });
    const sections = container.querySelectorAll('.memory-panel__section');
    expect(sections).toHaveLength(1);
    expect(sections[0].textContent).toContain('Global Memory (/shared/CLAUDE.md)');
    expect(sections[0].textContent).toContain('# Shared memory body');
  });

  it('renders `(empty)` when global memory is the empty string', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator({ getGlobalMemory: vi.fn(async () => '') });
    panel.setOrchestrator(orch as unknown as never);
    await vi.waitFor(() => {
      expect(container.querySelector('.memory-panel__memory-content')).not.toBeNull();
    });
    expect(container.querySelector('.memory-panel__memory-content')!.textContent).toBe('(empty)');
  });

  it('renders `(not available)` when getGlobalMemory throws', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator({
      getGlobalMemory: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    panel.setOrchestrator(orch as unknown as never);
    await vi.waitFor(() => {
      expect(container.querySelector('.memory-panel__memory-content')).not.toBeNull();
    });
    expect(container.querySelector('.memory-panel__memory-content')!.textContent).toBe(
      '(not available)'
    );
  });

  it('renders a cone memory section pointing at /workspace/CLAUDE.md', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const fs = {
      readFile: vi.fn(async () => '## Cone CLAUDE body'),
    };
    const orch = makeOrchestrator({
      getScoopContext: vi.fn(() => ({ getFS: () => fs })),
      getScoop: vi.fn(() => ({ isCone: true, folder: 'cone', assistantLabel: 'Sliccy' })),
    });
    panel.setOrchestrator(orch as unknown as never);
    panel.setSelectedScoop('cone-jid');
    await vi.waitFor(() => {
      const sections = container.querySelectorAll('.memory-panel__section');
      expect(sections.length).toBeGreaterThanOrEqual(2);
    });
    const headers = Array.from(container.querySelectorAll('.memory-panel__section-header'));
    const coneHeader = headers.find((h) => h.textContent?.includes('Cone'));
    expect(coneHeader?.textContent).toContain('/workspace/CLAUDE.md');
    expect(coneHeader?.textContent).toContain('Sliccy');
    expect(container.textContent).toContain('## Cone CLAUDE body');
  });

  it('renders a scoop memory section pointing at /scoops/<folder>/CLAUDE.md', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const fs = {
      readFile: vi.fn(async () => '## Scoop CLAUDE body'),
    };
    const orch = makeOrchestrator({
      getScoopContext: vi.fn(() => ({ getFS: () => fs })),
      getScoop: vi.fn(() => ({ isCone: false, folder: 'researcher', assistantLabel: 'Cherry' })),
    });
    panel.setOrchestrator(orch as unknown as never);
    panel.setSelectedScoop('scoop-jid');
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.memory-panel__section').length).toBeGreaterThanOrEqual(2);
    });
    const headers = Array.from(container.querySelectorAll('.memory-panel__section-header'));
    const scoopHeader = headers.find((h) => h.textContent?.includes('Scoop'));
    expect(scoopHeader?.textContent).toContain('/scoops/researcher/CLAUDE.md');
    expect(scoopHeader?.textContent).toContain('Cherry');
  });

  it('decodes a Uint8Array file body via TextDecoder', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const bytes = new TextEncoder().encode('## binary-body');
    const fs = {
      readFile: vi.fn(async () => bytes),
    };
    const orch = makeOrchestrator({
      getScoopContext: vi.fn(() => ({ getFS: () => fs })),
      getScoop: vi.fn(() => ({ isCone: true, folder: 'cone', assistantLabel: 'C' })),
    });
    panel.setOrchestrator(orch as unknown as never);
    panel.setSelectedScoop('cone-jid');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('## binary-body');
    });
  });

  it('shows `(filesystem not ready)` when getFS returns null', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator({
      getScoopContext: vi.fn(() => ({ getFS: () => null })),
      getScoop: vi.fn(() => ({ isCone: true, folder: 'cone', assistantLabel: 'C' })),
    });
    panel.setOrchestrator(orch as unknown as never);
    panel.setSelectedScoop('cone-jid');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('(filesystem not ready)');
    });
  });

  it('shows `(no memory file yet)` when readFile throws', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const fs = {
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    };
    const orch = makeOrchestrator({
      getScoopContext: vi.fn(() => ({ getFS: () => fs })),
      getScoop: vi.fn(() => ({ isCone: false, folder: 'x', assistantLabel: 'X' })),
    });
    panel.setOrchestrator(orch as unknown as never);
    panel.setSelectedScoop('jid');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('(no memory file yet)');
    });
  });

  it('does not render a scoop section when getScoopContext returns null', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator();
    panel.setOrchestrator(orch as unknown as never);
    panel.setSelectedScoop('jid');
    await vi.waitFor(() => {
      expect(container.querySelector('.memory-panel__section')).not.toBeNull();
    });
    expect(container.querySelectorAll('.memory-panel__section')).toHaveLength(1);
  });

  it('does not re-render identical content (innerHTML guard)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator();
    panel.setOrchestrator(orch as unknown as never);
    await vi.waitFor(() => {
      expect(container.querySelector('.memory-panel__section')).not.toBeNull();
    });
    const firstSection = container.querySelector('.memory-panel__section');
    await panel.refresh();
    expect(container.querySelector('.memory-panel__section')).toBe(firstSection);
  });
});

describe('MemoryPanel — setOrchestrator / dispose', () => {
  it('schedules a 5 s refresh timer that dispose() clears', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    const orch = makeOrchestrator();
    panel.setOrchestrator(orch as unknown as never);
    await vi.waitFor(() => {
      expect(orch.getGlobalMemory).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(orch.getGlobalMemory).toHaveBeenCalledTimes(2);
    panel.dispose();
    await vi.advanceTimersByTimeAsync(20000);
    expect(orch.getGlobalMemory).toHaveBeenCalledTimes(2);
  });

  it('dispose() is safe to call before setOrchestrator()', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new MemoryPanel(container);
    expect(() => panel.dispose()).not.toThrow();
  });
});
