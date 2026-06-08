/**
 * `setup-skill-drop.ts` — boot stage that mounts the page-level
 * drag-and-drop surface used by both `mainExtension` and
 * `mainStandaloneWorker` for `.skill` archive installs and chat-attachment
 * drops. Extracted verbatim from `main.ts` (overlay, toast, install
 * handler) — behavior is unchanged.
 */

import type { VirtualFS } from '../../fs/index.js';
import { installSkillFromDrop } from '../../skills/install-from-drop.js';
import {
  findDroppedNonSkillTransferFiles,
  findDroppedSkillTransferFile,
  hasDroppedFiles,
} from '../skill-drop.js';

export type SkillDropNoticeKind = 'success' | 'error';

interface SkillDropOverlay {
  show(title: string, description: string): void;
  hide(): void;
}

function createSkillDropOverlay(): SkillDropOverlay {
  const overlay = document.createElement('div');
  overlay.className = 'skill-drop-overlay';

  const card = document.createElement('div');
  card.className = 'skill-drop-overlay__card';

  const titleEl = document.createElement('div');
  titleEl.className = 'skill-drop-overlay__title';
  card.appendChild(titleEl);

  const descEl = document.createElement('div');
  descEl.className = 'skill-drop-overlay__desc';
  card.appendChild(descEl);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  return {
    show(title: string, description: string): void {
      titleEl.textContent = title;
      descEl.textContent = description;
      overlay.classList.add('skill-drop-overlay--visible');
    },
    hide(): void {
      overlay.classList.remove('skill-drop-overlay--visible');
    },
  };
}

export function createSkillDropToast(): (message: string, kind: SkillDropNoticeKind) => void {
  const container = document.createElement('div');
  container.className = 'skill-drop-toast-container';
  document.body.appendChild(container);

  return (message: string, kind: SkillDropNoticeKind): void => {
    const toast = document.createElement('div');
    toast.className = `skill-drop-toast skill-drop-toast--${kind}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('skill-drop-toast--visible'));
    const dismiss = () => {
      toast.classList.remove('skill-drop-toast--visible');
      window.setTimeout(() => toast.remove(), 180);
    };
    window.setTimeout(dismiss, 4200);
  };
}

/**
 * Dependencies for `setupSkillDrop()` — wires page-level dragenter /
 * dragover / drop handlers that install `.skill` archives into the
 * supplied `fs` and forward other files to the chat panel attachment
 * channel.
 */
export interface SkillDropSetupDeps {
  /** VFS the skill archive contents are written into. */
  fs: VirtualFS;
  /** Toast emitter (use {@link createSkillDropToast}). */
  onNotice: (message: string, kind: SkillDropNoticeKind) => void;
  /** Called after a successful install (e.g. refresh the file browser). */
  onInstalled: () => Promise<void>;
  /** Optional sink for non-skill dropped files (e.g. add to chat). */
  onAttachFiles?: (files: File[]) => Promise<void>;
}

/**
 * Install the page-level drag/drop install surface. Returns no handle —
 * the listeners live for the page lifetime (matches the original
 * behavior).
 */
export function setupSkillDrop(deps: SkillDropSetupDeps): void {
  const { fs, onNotice, onInstalled, onAttachFiles } = deps;
  const overlay = createSkillDropOverlay();
  let dragDepth = 0;
  let installInProgress = false;

  const resetDrag = (): void => {
    dragDepth = 0;
    if (!installInProgress) overlay.hide();
  };

  window.addEventListener('dragenter', (event) => {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    if (!installInProgress) {
      overlay.show('Drop files', '.skill archives install; other files attach to chat.');
    }
  });

  window.addEventListener('dragover', (event) => {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!installInProgress) {
      overlay.show('Drop files', '.skill archives install; other files attach to chat.');
    }
  });

  window.addEventListener('dragleave', () => {
    if (dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && !installInProgress) overlay.hide();
  });

  window.addEventListener('dragend', resetDrag);
  window.addEventListener('blur', resetDrag);

  window.addEventListener('drop', async (event) => {
    const skillFile = findDroppedSkillTransferFile(event.dataTransfer);
    const attachmentFiles = findDroppedNonSkillTransferFiles<File>(event.dataTransfer);

    if (!skillFile && attachmentFiles.length === 0) {
      resetDrag();
      return;
    }
    event.preventDefault();
    dragDepth = 0;

    if (skillFile && installInProgress) {
      overlay.hide();
      onNotice('Another .skill installation is already in progress.', 'error');
      return;
    }

    if (attachmentFiles.length > 0 && onAttachFiles) {
      try {
        await onAttachFiles(attachmentFiles);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onNotice(`Failed to attach dropped files: ${message}`, 'error');
      }
    }

    if (skillFile) {
      installInProgress = true;
      overlay.show('Installing skill…', skillFile.name);
      try {
        const result = await installSkillFromDrop(fs, skillFile);
        await onInstalled();
        onNotice(
          `Installed "${result.skillName}" to ${result.destinationPath} (${result.fileCount} files).`,
          'success'
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onNotice(`Failed to install dropped skill: ${message}`, 'error');
      } finally {
        installInProgress = false;
        overlay.hide();
      }
    } else {
      overlay.hide();
    }
  });
}
