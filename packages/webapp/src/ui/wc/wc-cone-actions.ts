import type { RegisteredScoop, WorkUnitModel } from '../../scoops/types.js';
import { recordToWorkUnitSummary } from '../../work-unit/client/from-record.js';
import { modelForUnit } from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { buildWorkUnitRecord } from '../../work-unit/manager.js';
import { rootsOf } from '../../work-unit/policy.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { rootForSelection, switcherLabelFor } from './wc-unit-context.js';

export interface ConeActionsDeps {
  freezer: HTMLElement;
  client: Pick<OffscreenClient, 'getScoops' | 'registerScoop' | 'unregisterScoop'>;
  getSelected(): WorkUnitSummary | null;

  getUnits(): readonly WorkUnitSummary[];
  selectScoop(unit: WorkUnitSummary): void;

  freezeCone(root: RegisteredScoop): Promise<void>;
  log: { warn(message: string, ...rest: unknown[]): void };
}

export interface ConeActionsHandles {
  refresh(): void;

  dialog(): HTMLElement | null;
}

const BTN_BASE =
  'padding:0.5rem 1.25rem;border-radius:0.375rem;cursor:pointer;font:inherit;font-size:0.875rem;';
const BTN_PRIMARY = `${BTN_BASE}border:none;background:var(--s2-accent-color,#0265dc);color:#fff;`;
const BTN_DANGER = `${BTN_BASE}border:none;background:#d23;color:#fff;`;
const BTN_PLAIN = `${BTN_BASE}background:transparent;border:1px solid var(--s2-border-color,#e0e0e0);color:inherit;`;

export function buildNewConeRecord(
  name: string,
  existing: readonly RegisteredScoop[],
  model?: WorkUnitModel
): RegisteredScoop {
  const placeholder = `cone-pending-${existing.length + 1}`;
  return {
    ...buildWorkUnitRecord({ parentId: null, name, folder: placeholder }),
    assistantLabel: name,

    ...(model ? { model } : {}),
  };
}

type ConeDialog = HTMLElement & { show?: () => void; hide?: () => void };

interface ConeDialogSpec {
  heading: string;
  body: HTMLElement;
  actions: Array<{ text: string; style: string; data: string; onClick: () => void }>;

  onDismiss(dialog: ConeDialog): void;
}

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

export interface NewConeDraft {
  name: string;

  brief: string;
}

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
  const brief = doc.createElement('textarea');
  brief.name = 'brief';
  brief.placeholder = 'What should it work on? (optional)';
  brief.setAttribute('aria-label', 'What the cone should work on');
  brief.rows = 3;
  brief.style.cssText = `${field}resize:vertical;`;
  form.append(name, brief);
  const read = (): NewConeDraft => ({ name: name.value.trim(), brief: brief.value.trim() });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit(read());
  });

  brief.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit(read());
    }
  });
  (form as HTMLFormElement & { readDraft?: () => NewConeDraft }).readDraft = read;
  return form;
}

export function wireConeActions(deps: ConeActionsDeps): ConeActionsHandles {
  const { freezer, client, log } = deps;
  const doc = freezer.ownerDocument;

  let pendingSelect: string | null = null;
  let dropping = false;
  let dialog: ConeDialog | null = null;

  const row = (): HTMLElement | null => freezer.querySelector('slicc-freezer-new');

  const currentRoot = (): WorkUnitSummary | undefined =>
    rootForSelection(deps.getUnits(), deps.getSelected());

  const unitFor = (record: RegisteredScoop): WorkUnitSummary =>
    deps.getUnits().find((unit) => unit.id === record.jid) ?? recordToWorkUnitSummary(record);

  const closeDialog = (): void => {
    if (!dialog) return;
    const d = dialog;
    dialog = null;
    d.hide?.();
    d.remove();
  };

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
    const selected = currentRoot();
    const record = buildNewConeRecord(
      draft.name,
      client.getScoops(),
      modelForUnit(deps.getUnits(), selected?.id)
    );
    pendingSelect = draft.name;
    void client
      .registerScoop(record, draft.brief ? { description: draft.brief, prompt: draft.brief } : {})
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

      const wasMine = currentRoot()?.id === root.jid;
      try {
        await client.unregisterScoop(root.jid);
      } catch (err) {
        log.warn('WC cone drop failed', err);
      }
      if (wasMine) {
        const next = rootsOf(client.getScoops()).find((s) => s.jid !== root.jid);
        if (next) deps.selectScoop(unitFor(next));
      }
      dropping = false;
      render();
    })();
  };

  const askDrop = (root: WorkUnitSummary): void => {
    const label = switcherLabelFor(root);
    const body = doc.createElement('p');
    body.textContent = 'Its chat goes to the Freezer.';
    body.style.cssText = 'font-size:0.875rem;margin:0;';
    openDialog({
      heading: `Drop ${label}?`,
      body,
      actions: [
        { text: 'Drop', style: BTN_DANGER, data: 'drop', onClick: () => drop(root.id) },
        { text: 'Cancel', style: BTN_PLAIN, data: 'cancel', onClick: closeDialog },
      ],
    });
  };

  const render = (): void => {
    const roots = rootsOf(client.getScoops());

    if (pendingSelect !== null) {
      const landed = roots.find(
        (s) => s.name === pendingSelect && !s.folder.startsWith('cone-pending-')
      );
      if (landed) {
        pendingSelect = null;
        if (deps.getSelected()?.id !== landed.jid) deps.selectScoop(unitFor(landed));
      }
    }
    const r = row();
    r?.setAttribute('cones', String(roots.length));

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
