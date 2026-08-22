/**
 * Cone actions of the freezer rail (#1666 / #2272): the `new-cone` and
 * `drop-cone` events `<slicc-freezer-new>` fires from its expanded action
 * row, plus the cone count that decides which of the two it shows.
 *
 * There is no cone list here — the top tab strip is the only switcher, and
 * nothing is ever inserted into the rail: both actions open a `<slicc-dialog>`
 * (name a new cone / confirm a drop), so the frozen cards below the row never
 * move (#2272).
 *
 * Dropping a cone freezes its chat without extracting memories and keeps its
 * frozen cards; the next-oldest root becomes the primary. The last cone can
 * never be dropped — the row hides the action, the client and the kernel
 * refuse it too. Followers never mount this (the leader owns the registry).
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import { buildWorkUnitRecord } from '../../work-unit/manager.js';
import { rootsOf } from '../../work-unit/policy.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { rootForSelection, switcherLabelFor } from './wc-unit-context.js';

export interface ConeActionsDeps {
  /** The freezer rail; the action row is its `<slicc-freezer-new>` child. */
  freezer: HTMLElement;
  client: Pick<OffscreenClient, 'getScoops' | 'registerScoop' | 'unregisterScoop'>;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  /**
   * Archive the cone's chat before it goes (the freezer, no memory
   * extraction). Resolves once the archive is durable; a failure is logged
   * and the drop proceeds — the kernel's cascade would lose the chat
   * otherwise, so the caller must only reject on a truly unrecoverable VFS.
   */
  freezeCone(root: RegisteredScoop): Promise<void>;
  log: { warn(message: string, ...rest: unknown[]): void };
}

export interface ConeActionsHandles {
  /** Re-sync the row's cone count and the pending-selection with the roster. */
  refresh(): void;
  /** The open dialog, if any (for tests). */
  dialog(): HTMLElement | null;
}

const BTN_PRIMARY =
  'padding:0.5rem 1.25rem;border-radius:0.375rem;border:none;cursor:pointer;' +
  'background:var(--s2-accent-color,#0265dc);color:#fff;font-size:0.875rem;';
const BTN_DANGER =
  'padding:0.5rem 1.25rem;border-radius:0.375rem;border:none;cursor:pointer;' +
  'background:#d23;color:#fff;font-size:0.875rem;';
const BTN_PLAIN =
  'padding:0.5rem 1.25rem;border-radius:0.375rem;cursor:pointer;' +
  'background:transparent;border:1px solid var(--s2-border-color,#e0e0e0);font-size:0.875rem;';

/** Build the optimistic record the rail registers for a new cone. */
export function buildNewConeRecord(
  name: string,
  existing: readonly RegisteredScoop[]
): RegisteredScoop {
  // The kernel assigns the real folder / jid (`handleConeCreate`); the rail
  // only needs a placeholder that reads as a root until `scoop-created`
  // replaces it by name.
  const placeholder = `cone-pending-${existing.length + 1}`;
  return {
    ...buildWorkUnitRecord({ parentId: null, name, folder: placeholder }),
    assistantLabel: name,
  };
}

type ConeDialog = HTMLElement & { show?: () => void; hide?: () => void };

interface ConeDialogSpec {
  heading: string;
  body: HTMLElement;
  actions: Array<{ text: string; style: string; data: string; onClick: () => void }>;
  /** Fired when the dialog dismisses itself (Escape, ✕, backdrop). */
  onDismiss(dialog: ConeDialog): void;
}

/** Build a `<slicc-dialog>` with footer buttons; the caller mounts and shows it. */
function buildConeDialog(doc: Document, spec: ConeDialogSpec): ConeDialog {
  const d = doc.createElement('slicc-dialog') as ConeDialog;
  d.setAttribute('heading', spec.heading);
  d.append(spec.body);
  for (const action of spec.actions) {
    const btn = doc.createElement('button');
    btn.setAttribute('slot', 'footer');
    btn.type = 'button';
    btn.dataset.coneAction = action.data;
    btn.textContent = action.text;
    btn.style.cssText = action.style;
    btn.addEventListener('click', action.onClick);
    d.append(btn);
  }
  d.addEventListener('slicc-dialog-close', () => spec.onDismiss(d));
  return d;
}

/** What the "New cone" dialog collects. Only the name is required. */
export interface NewConeDraft {
  name: string;
  /** What the cone is for — becomes its system-prompt note. */
  description: string;
  /** First message; starts the cone's first turn right away. */
  prompt: string;
}

/** The "New cone" body: name, purpose, first message. Enter in the name field submits. */
function buildNameForm(doc: Document, onSubmit: (draft: NewConeDraft) => void): HTMLFormElement {
  const form = doc.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;padding:0.25rem 0;';
  const field =
    'font-size:0.9375rem;padding:0.5rem 0.625rem;border:1px solid var(--s2-border-color,#e0e0e0);' +
    'border-radius:0.375rem;background:transparent;color:inherit;font-family:inherit;';
  const name = doc.createElement('input');
  name.type = 'text';
  name.name = 'name';
  name.placeholder = 'Name';
  name.setAttribute('aria-label', 'Cone name');
  name.maxLength = 40;
  name.autocomplete = 'off';
  name.required = true;
  name.style.cssText = field;
  const description = doc.createElement('input');
  description.type = 'text';
  description.name = 'description';
  description.placeholder = 'What is it for? (optional)';
  description.setAttribute('aria-label', 'What the cone is for');
  description.maxLength = 200;
  description.autocomplete = 'off';
  description.style.cssText = field;
  const prompt = doc.createElement('textarea');
  prompt.name = 'prompt';
  prompt.placeholder = 'First message (optional)';
  prompt.setAttribute('aria-label', 'First message');
  prompt.rows = 3;
  prompt.style.cssText = `${field}resize:vertical;`;
  form.append(name, description, prompt);
  const read = (): NewConeDraft => ({
    name: name.value.trim(),
    description: description.value.trim(),
    prompt: prompt.value.trim(),
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit(read());
  });
  // Submit from the textarea with ⌘/Ctrl+Enter (plain Enter is a newline).
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit(read());
    }
  });
  (form as HTMLFormElement & { readDraft?: () => NewConeDraft }).readDraft = read;
  return form;
}

/** Wire the row's cone actions and keep its cone count in sync. */
export function wireConeActions(deps: ConeActionsDeps): ConeActionsHandles {
  const { freezer, client, log } = deps;
  const doc = freezer.ownerDocument;

  /** Name of a cone we just asked the kernel for — selected once it lands. */
  let pendingSelect: string | null = null;
  let dropping = false;
  let dialog: ConeDialog | null = null;

  const row = (): HTMLElement | null => freezer.querySelector('slicc-freezer-new');

  /** The root the actions apply to: the selected cone (or the one owning the selected scoop). */
  const currentRoot = (): RegisteredScoop | undefined =>
    rootForSelection(client.getScoops(), deps.getSelected());

  const closeDialog = (): void => {
    if (!dialog) return;
    const d = dialog;
    dialog = null;
    d.hide?.();
    d.remove();
  };

  /**
   * One modal at a time; a second action while one is open replaces it. The
   * dialog lives on `document.body`, never in the rail, so the cards below
   * the row do not move.
   */
  const openDialog = (spec: Omit<ConeDialogSpec, 'onDismiss'>): void => {
    closeDialog();
    const d = buildConeDialog(doc, {
      ...spec,
      onDismiss: (closed) => {
        if (dialog === closed) dialog = null;
        closed.remove();
      },
    });
    dialog = d;
    doc.body.append(d);
    d.show?.();
  };

  const create = (draft: NewConeDraft): void => {
    if (!draft.name) return;
    closeDialog();
    const record = buildNewConeRecord(draft.name, client.getScoops());
    pendingSelect = draft.name;
    void client
      .registerScoop(record, {
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.prompt ? { prompt: draft.prompt } : {}),
      })
      .catch((err) => log.warn('WC cone create failed', err));
    render();
  };

  const askName = (): void => {
    const form = buildNameForm(doc, create) as HTMLFormElement & { readDraft: () => NewConeDraft };
    openDialog({
      heading: 'New cone',
      body: form,
      actions: [
        {
          text: 'Create',
          style: BTN_PRIMARY,
          data: 'create',
          onClick: () => create(form.readDraft()),
        },
        { text: 'Cancel', style: BTN_PLAIN, data: 'cancel', onClick: closeDialog },
      ],
    });
    queueMicrotask(() => form.querySelector('input')?.focus());
  };

  const drop = (jid: string): void => {
    closeDialog();
    const roots = rootsOf(client.getScoops());
    const root = roots.find((s) => s.jid === jid);
    // Never drop the last cone — the row hides the action in that state and
    // the client and the kernel refuse it too; this guards a stale confirm.
    if (!root || roots.length <= 1 || dropping) {
      render();
      return;
    }
    dropping = true;
    render();
    void (async () => {
      try {
        await deps.freezeCone(root);
      } catch (err) {
        log.warn('WC cone freeze before drop failed', err);
      }
      // Move off the cone first so nothing renders a unit that is going away;
      // the oldest surviving root is the primary, so that is the fallback.
      const wasMine = currentRoot()?.jid === root.jid;
      try {
        await client.unregisterScoop(root.jid);
      } catch (err) {
        log.warn('WC cone drop failed', err);
      }
      if (wasMine) {
        const next = rootsOf(client.getScoops()).find((s) => s.jid !== root.jid);
        if (next) deps.selectScoop(next);
      }
      dropping = false;
      render();
    })();
  };

  const askDrop = (root: RegisteredScoop): void => {
    const label = switcherLabelFor(root);
    const body = doc.createElement('p');
    body.textContent = 'Its chat goes to the Freezer.';
    body.style.cssText = 'font-size:0.875rem;margin:0;';
    openDialog({
      heading: `Drop ${label}?`,
      body,
      actions: [
        { text: 'Drop', style: BTN_DANGER, data: 'drop', onClick: () => drop(root.jid) },
        { text: 'Cancel', style: BTN_PLAIN, data: 'cancel', onClick: closeDialog },
      ],
    });
  };

  const render = (): void => {
    const roots = rootsOf(client.getScoops());
    // A cone created from the row becomes the active one as soon as the
    // kernel's real record (not the optimistic placeholder) is in the roster.
    if (pendingSelect !== null) {
      const landed = roots.find(
        (s) => s.name === pendingSelect && !s.folder.startsWith('cone-pending-')
      );
      if (landed) {
        pendingSelect = null;
        if (deps.getSelected()?.jid !== landed.jid) deps.selectScoop(landed);
      }
    }
    const r = row();
    r?.setAttribute('cones', String(roots.length));
    // While the drop's freeze runs the row is busy; the user cannot start a
    // second drop or a new chat on a cone that is going away.
    r?.toggleAttribute('busy', dropping);
  };

  freezer.addEventListener('new-cone', askName);
  freezer.addEventListener('drop-cone', () => {
    const root = currentRoot();
    if (!root || rootsOf(client.getScoops()).length <= 1 || dropping) return;
    askDrop(root);
  });

  render();
  return { refresh: render, dialog: () => dialog };
}
