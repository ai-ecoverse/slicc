/**
 * Delete a frozen chat from the Freezer rail. The card's trash button fires
 * `freezer-card-delete`; a confirm dialog names the chat; Delete runs
 * `deleteFrozenSession` (files first, index row last — a failure keeps the
 * card AND the dialog for a retry). Deleting the chat on screen hands back
 * to the cone it came from.
 */

import type { BootStageLogger } from '../boot/types.js';
import { BTN_DANGER, BTN_PLAIN, buildConeDialog, type ConeDialog } from './wc-cone-actions.js';
import type { FrozenSessionIndexEntry } from './wc-freezer.js';
import type { WcPageVfs } from './wc-live.js';

export interface FreezerDeleteDeps {
  /** The rail; its cards fire `freezer-card-delete`. */
  freezer: HTMLElement;
  openVfs(): Promise<WcPageVfs>;
  /** The rows the rail last rendered. */
  getEntries(): readonly FrozenSessionIndexEntry[];
  /** `sessionId ?? filename` of the frozen chat on screen, or null. */
  getViewedId(): string | null;
  /** Leave a frozen chat that was just deleted while on screen. */
  leaveViewed(entry: FrozenSessionIndexEntry): void;
  refreshFreezer(): void;
  log: BootStageLogger;
}

export interface FreezerDeleteHandles {
  /** The open confirm dialog, if any (for tests). */
  dialog(): HTMLElement | null;
}

const FAILED_COPY = "Couldn't delete everything — try again.";

function confirmBody(doc: Document, title: string): HTMLElement {
  const body = doc.createElement('p');
  body.textContent = `“${title}” and its transcript will be deleted. Memories already learned from it are kept.`;
  body.style.cssText = 'font-size:0.875rem;margin:0;';
  return body;
}

function showFailure(body: HTMLElement): void {
  let line = body.parentElement?.querySelector<HTMLElement>('[data-freezer-delete-error]');
  if (!line) {
    line = body.ownerDocument.createElement('p');
    line.setAttribute('data-freezer-delete-error', '');
    line.setAttribute('role', 'alert');
    line.style.cssText = 'font-size:0.8125rem;margin:0.5rem 0 0;color:#d23;';
    body.after(line);
  }
  line.textContent = FAILED_COPY;
}

/** Focus fell to <body> because a refresh replaced the opener: use the new card. */
function restoreFocus(freezer: HTMLElement, slug: string): void {
  const doc = freezer.ownerDocument;
  if (doc.activeElement && doc.activeElement !== doc.body) return;
  const card = Array.from(freezer.querySelectorAll('slicc-freezer-card')).find(
    (candidate) => candidate.getAttribute('slug') === slug
  );
  card?.querySelector<HTMLElement>('.slicc-fzcard__delete')?.focus();
}

function deleteKey(entry: FrozenSessionIndexEntry): { filename: string; sessionId?: string } {
  return entry.sessionId
    ? { filename: entry.filename, sessionId: entry.sessionId }
    : { filename: entry.filename };
}

/** Wire the rail's trash buttons to a confirm + delete. One dialog at a time. */
export function wireFreezerDelete(deps: FreezerDeleteDeps): FreezerDeleteHandles {
  const doc = deps.freezer.ownerDocument;
  let open: { slug: string; dialog: ConeDialog } | null = null;
  const running = new Set<string>();

  const close = (): void => {
    if (!open) return;
    const { slug, dialog } = open;
    open = null;
    dialog.hide?.();
    dialog.remove();
    restoreFocus(deps.freezer, slug);
  };

  const run = async (
    entry: FrozenSessionIndexEntry,
    dialog: ConeDialog,
    body: HTMLElement
  ): Promise<void> => {
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[slot="footer"]'));
    for (const button of buttons) button.disabled = true;
    running.add(entry.filename);
    try {
      const { writer } = await deps.openVfs();
      const { deleteFrozenSession } = await import('../frozen-session-delete.js');
      const result = await deleteFrozenSession(writer, deleteKey(entry));
      if (result.status === 'failed') throw new Error(result.errors.join('; '));
      if (result.status !== 'deleted') {
        deps.log.warn('WC frozen chat delete skipped', { filename: entry.filename, ...result });
      } else if (deps.getViewedId() === (entry.sessionId ?? entry.filename)) {
        deps.leaveViewed(entry);
      }
      if (open?.dialog === dialog) close();
      deps.refreshFreezer();
    } catch (err) {
      deps.log.error('WC frozen chat delete failed', err);
      showFailure(body);
      for (const button of buttons) button.disabled = false;
    } finally {
      running.delete(entry.filename);
    }
  };

  const ask = (slug: string): void => {
    if (open?.slug === slug || running.has(slug)) return;
    const entry = deps.getEntries().find((candidate) => candidate.filename === slug);
    if (!entry || entry.live) return;
    close();
    const body = confirmBody(doc, entry.title);
    const dialog: ConeDialog = buildConeDialog(doc, {
      heading: 'Delete frozen chat?',
      body,
      actions: [
        {
          text: 'Delete',
          style: BTN_DANGER,
          data: 'delete',
          onClick: () => void run(entry, dialog, body),
        },
        { text: 'Cancel', style: BTN_PLAIN, data: 'cancel', onClick: close },
      ],
      onDismiss: (closed) => {
        if (open?.dialog === closed) open = null;
        closed.remove();
        restoreFocus(deps.freezer, slug);
      },
    });
    open = { slug, dialog };
    doc.body.append(dialog);
    dialog.show?.();
  };

  deps.freezer.addEventListener('freezer-card-delete', (event) => {
    const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
    if (slug) ask(slug);
  });

  return { dialog: () => open?.dialog ?? null };
}
