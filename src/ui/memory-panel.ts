/**
 * Memory Panel — displays CLAUDE.md memory files for global and scoop contexts.
 */

import type { Orchestrator } from '../scoops/index.js';

export class MemoryPanel {
  private container: HTMLElement;
  private bodyEl!: HTMLElement;
  private orchestrator: Orchestrator | null = null;
  private selectedScoopJid: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 5000);
  }

  setSelectedScoop(jid: string | null): void {
    this.selectedScoopJid = jid;
    this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.orchestrator) return;

    const tmp = document.createElement('div');
    tmp.className = 'memory-panel__content';

    // Global memory section
    const globalSection = document.createElement('div');
    globalSection.className = 'memory-panel__section';

    const globalHeader = document.createElement('div');
    globalHeader.className = 'memory-panel__section-header';
    globalHeader.textContent = 'Global Memory (/shared/CLAUDE.md)';
    globalSection.appendChild(globalHeader);

    const globalContent = document.createElement('div');
    globalContent.className = 'memory-panel__memory-content';

    try {
      const globalMemory = await this.orchestrator.getGlobalMemory();
      globalContent.textContent = globalMemory || '(empty)';
    } catch {
      globalContent.textContent = '(not available)';
    }
    globalSection.appendChild(globalContent);
    tmp.appendChild(globalSection);

    // Scoop memory section (if a scoop is selected)
    if (this.selectedScoopJid) {
      const context = this.orchestrator.getScoopContext(this.selectedScoopJid);
      const scoop = this.orchestrator.getScoop(this.selectedScoopJid);

      if (context && scoop) {
        const scoopSection = document.createElement('div');
        scoopSection.className = 'memory-panel__section';

        const scoopHeader = document.createElement('div');
        scoopHeader.className = 'memory-panel__section-header';
        scoopHeader.textContent = `${scoop.isCone ? 'Cone' : 'Scoop'}: ${scoop.assistantLabel}`;
        scoopSection.appendChild(scoopHeader);

        const scoopContent = document.createElement('div');
        scoopContent.className = 'memory-panel__memory-content';

        try {
          const fs = context.getFS();
          if (fs) {
            const memoryPath = scoop.isCone
              ? '/workspace/CLAUDE.md'
              : `/scoops/${scoop.folder}/CLAUDE.md`;
            const content = await fs.readFile(memoryPath, { encoding: 'utf-8' });
            scoopContent.textContent =
              typeof content === 'string' ? content : new TextDecoder().decode(content);
          } else {
            scoopContent.textContent = '(filesystem not ready)';
          }
        } catch {
          scoopContent.textContent = '(no memory file yet)';
        }
        scoopSection.appendChild(scoopContent);
        tmp.appendChild(scoopSection);
      }
    }

    // Only update if changed
    if (tmp.innerHTML !== this.bodyEl.innerHTML) {
      while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
      while (tmp.firstChild) this.bodyEl.appendChild(tmp.firstChild);
    }
  }

  private render(): void {
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
    this.container.classList.add('memory-panel');

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'memory-panel__body';
    this.container.appendChild(this.bodyEl);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
