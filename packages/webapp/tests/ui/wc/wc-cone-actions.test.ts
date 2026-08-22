// @vitest-environment jsdom
/**
 * Cone actions of the freezer rail (#2272): `new-cone` / `drop-cone` from
 * the action row, the cone count that decides which the row shows, and the
 * dialogs (name a cone / confirm a drop) they open — never anything in the
 * rail itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { buildNewConeRecord, wireConeActions } from '../../../src/ui/wc/wc-cone-actions.js';

function root(jid: string, folder: string, label: string, addedAt: string): RegisteredScoop {
  return {
    jid,
    name: label,
    folder,
    isCone: true,
    type: 'cone',
    requiresTrigger: false,
    assistantLabel: label,
    addedAt,
    parentJid: null,
  };
}

function child(jid: string, parentJid: string): RegisteredScoop {
  return {
    jid,
    name: jid,
    folder: `${jid}-scoop`,
    isCone: false,
    type: 'scoop',
    requiresTrigger: true,
    assistantLabel: jid,
    addedAt: '2026-01-03T00:00:00.000Z',
    parentJid,
  };
}

const primary = root('cone_1', 'cone', 'sliccy', '2026-01-01T00:00:00.000Z');
const research = root('cone_2', 'cone-research', 'Research', '2026-01-02T00:00:00.000Z');

function harness(initial: RegisteredScoop[], opts: { freezeFails?: boolean } = {}) {
  let scoops = [...initial];
  let selected: RegisteredScoop | null = scoops[0] ?? null;
  const freezer = document.createElement('div');
  const row = document.createElement('slicc-freezer-new');
  freezer.append(row);
  document.body.append(freezer);
  const client = {
    getScoops: () => scoops,
    registerScoop: vi.fn(
      async (scoop: RegisteredScoop, _options?: { description?: string; prompt?: string }) => {
        scoops = [...scoops, scoop];
      }
    ),
    unregisterScoop: vi.fn(async (jid: string) => {
      scoops = scoops.filter((s) => s.jid !== jid && s.parentJid !== jid);
    }),
  };
  const selectScoop = vi.fn((scoop: RegisteredScoop) => {
    selected = scoop;
  });
  const frozen: string[] = [];
  const freezeCone = vi.fn(async (unit: RegisteredScoop) => {
    if (opts.freezeFails) throw new Error('vfs down');
    frozen.push(unit.folder);
  });
  const warn = vi.fn();
  const handles = wireConeActions({
    freezer,
    client,
    getSelected: () => selected,
    selectScoop,
    freezeCone,
    log: { warn },
  });
  const fire = (type: 'new-cone' | 'drop-cone') => freezer.dispatchEvent(new CustomEvent(type));
  const dialog = () => handles.dialog();
  const action = (name: string) =>
    dialog()?.querySelector<HTMLButtonElement>(`[data-cone-action="${name}"]`) ?? null;
  const buttons = () =>
    Array.from(dialog()?.querySelectorAll('button[slot="footer"]') ?? []).map((b) => b.textContent);
  const landed = (record: RegisteredScoop) => {
    // The kernel replaces the optimistic placeholder by name.
    scoops = scoops.map((s) => (s.folder.startsWith('cone-pending-') ? record : s));
    handles.refresh();
  };
  return {
    row,
    client,
    selectScoop,
    freezeCone,
    frozen,
    warn,
    handles,
    fire,
    dialog,
    action,
    buttons,
    landed,
    get scoops() {
      return scoops;
    },
    get selected() {
      return selected;
    },
    select(scoop: RegisteredScoop) {
      selected = scoop;
    },
  };
}

describe('buildNewConeRecord', () => {
  it('builds an optimistic root placeholder the kernel will replace', () => {
    const record = buildNewConeRecord('Research', [primary]);
    expect(record.parentJid).toBeNull();
    expect(record.folder).toBe('cone-pending-2');
    expect(record.name).toBe('Research');
    expect(record.assistantLabel).toBe('Research');
  });
});

describe('wireConeActions', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('tells the row how many cones there are and adds nothing to the rail', () => {
    const h = harness([primary]);
    expect(h.row.getAttribute('cones')).toBe('1');
    expect(h.row.parentElement?.childElementCount).toBe(1);
    expect(h.dialog()).toBeNull();
    h.client.registerScoop(research);
    h.handles.refresh();
    expect(h.row.getAttribute('cones')).toBe('2');
    expect(h.row.parentElement?.childElementCount).toBe(1);
  });

  it('new-cone opens a dialog; Create registers a root and selects it once it lands', async () => {
    const h = harness([primary]);
    h.fire('new-cone');
    const d = h.dialog() as HTMLElement;
    expect(d.tagName.toLowerCase()).toBe('slicc-dialog');
    expect(d.getAttribute('heading')).toBe('New cone');
    // On the body, not in the rail.
    expect(d.parentElement).toBe(document.body);
    expect(h.row.parentElement?.contains(d)).toBe(false);
    const input = d.querySelector('input[name="name"]') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Cone name');
    input.value = 'Research';
    (d.querySelector('input[name="description"]') as HTMLInputElement).value = ' Paper survey ';
    (d.querySelector('textarea[name="prompt"]') as HTMLTextAreaElement).value =
      'List the three most cited retrieval papers.';
    h.action('create')?.click();
    await vi.waitFor(() => expect(h.client.registerScoop).toHaveBeenCalledOnce());
    const [record, options] = h.client.registerScoop.mock.calls[0];
    expect(record.parentJid).toBeNull();
    expect(record.name).toBe('Research');
    // Purpose and first message ride along, trimmed.
    expect(options).toEqual({
      description: 'Paper survey',
      prompt: 'List the three most cited retrieval papers.',
    });
    // Dialog is gone, the placeholder is not selected…
    expect(h.dialog()).toBeNull();
    expect(document.querySelector('slicc-dialog')).toBeNull();
    expect(h.selectScoop).not.toHaveBeenCalled();
    // …the kernel's real record is.
    h.landed(research);
    expect(h.selected?.jid).toBe('cone_2');
  });

  it('Enter in the name field submits; an empty name does nothing', () => {
    const h = harness([primary]);
    h.fire('new-cone');
    const form = h.dialog()?.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(h.client.registerScoop).not.toHaveBeenCalled();
    expect(h.dialog()).not.toBeNull();
    (form.querySelector('input[name="name"]') as HTMLInputElement).value = '  Beta ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(h.client.registerScoop).toHaveBeenCalledOnce();
    expect(h.client.registerScoop.mock.calls[0][0].name).toBe('Beta');
    // Nothing optional was filled in → nothing optional on the wire.
    expect(h.client.registerScoop.mock.calls[0][1]).toEqual({});
    expect(h.dialog()).toBeNull();
  });

  it('⌘/Ctrl+Enter in the first-message field submits', () => {
    const h = harness([primary]);
    h.fire('new-cone');
    const d = h.dialog() as HTMLElement;
    (d.querySelector('input[name="name"]') as HTMLInputElement).value = 'Gamma';
    const prompt = d.querySelector('textarea[name="prompt"]') as HTMLTextAreaElement;
    prompt.value = 'go';
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.client.registerScoop).not.toHaveBeenCalled();
    prompt.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    expect(h.client.registerScoop).toHaveBeenCalledOnce();
    expect(h.client.registerScoop.mock.calls[0][1]).toEqual({ prompt: 'go' });
  });

  it('Cancel and the dialog closing itself both discard the name form', () => {
    const h = harness([primary]);
    h.fire('new-cone');
    h.action('cancel')?.click();
    expect(h.dialog()).toBeNull();
    expect(document.querySelector('slicc-dialog')).toBeNull();
    h.fire('new-cone');
    h.dialog()?.dispatchEvent(
      new CustomEvent('slicc-dialog-close', { detail: { reason: 'escape' } })
    );
    expect(h.dialog()).toBeNull();
    expect(document.querySelector('slicc-dialog')).toBeNull();
    expect(h.client.registerScoop).not.toHaveBeenCalled();
  });

  it('drop-cone asks in a dialog, then freezes the chat and drops the cone', async () => {
    const h = harness([primary, research, child('scoop_1', 'cone_2')]);
    h.select(research);
    h.fire('drop-cone');
    expect(h.dialog()?.getAttribute('heading')).toBe('Drop Research?');
    expect(h.buttons()).toEqual(['Drop', 'Cancel']);
    expect(h.client.unregisterScoop).not.toHaveBeenCalled();

    h.action('drop')?.click();
    expect(h.dialog()).toBeNull();
    // The row is busy while the freeze runs.
    expect(h.row.hasAttribute('busy')).toBe(true);
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    // Frozen BEFORE the drop, and only that cone.
    expect(h.frozen).toEqual(['cone-research']);
    expect(h.freezeCone.mock.invocationCallOrder[0]).toBeLessThan(
      h.client.unregisterScoop.mock.invocationCallOrder[0]
    );
    // Moved onto the surviving root (the oldest one is the primary).
    expect(h.selected?.jid).toBe('cone_1');
    expect(h.row.getAttribute('cones')).toBe('1');
    expect(h.row.hasAttribute('busy')).toBe(false);
  });

  it('drops the cone that owns the selected scoop', async () => {
    const helper = child('scoop_1', 'cone_2');
    const h = harness([primary, research, helper]);
    h.select(helper);
    h.fire('drop-cone');
    h.action('drop')?.click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    expect(h.selected?.jid).toBe('cone_1');
  });

  it('keeps the selection when another cone is dropped', async () => {
    const h = harness([primary, research]);
    h.select(research);
    h.fire('drop-cone');
    h.select(primary);
    h.action('drop')?.click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    expect(h.selectScoop).not.toHaveBeenCalled();
  });

  it('still drops when the freeze fails, but says so', async () => {
    const h = harness([primary, research], { freezeFails: true });
    h.select(research);
    h.fire('drop-cone');
    h.action('drop')?.click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    expect(h.warn).toHaveBeenCalledWith('WC cone freeze before drop failed', expect.any(Error));
  });

  it('never drops the last cone, even from a stale confirm', async () => {
    const h = harness([primary, research]);
    h.select(research);
    h.fire('drop-cone');
    expect(h.dialog()).not.toBeNull();
    // The other cone disappears underneath the open confirm.
    await h.client.unregisterScoop('cone_1');
    h.client.unregisterScoop.mockClear();
    h.handles.refresh();
    expect(h.row.getAttribute('cones')).toBe('1');
    h.action('drop')?.click();
    expect(h.client.unregisterScoop).not.toHaveBeenCalled();
    expect(h.dialog()).toBeNull();
    // With one cone the action does not even open a dialog.
    h.fire('drop-cone');
    expect(h.dialog()).toBeNull();
  });

  it('a second action replaces the open dialog instead of stacking', () => {
    const h = harness([primary, research]);
    h.fire('new-cone');
    h.fire('drop-cone');
    expect(document.querySelectorAll('slicc-dialog')).toHaveLength(1);
    expect(h.dialog()?.getAttribute('heading')).toMatch(/^Drop /);
  });
});
