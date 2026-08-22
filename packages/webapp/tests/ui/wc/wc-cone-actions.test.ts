// @vitest-environment jsdom
/**
 * Cone actions of the freezer rail (#2272): `new-cone` / `drop-cone` from
 * the action row, the cone count that decides which the row shows, and the
 * one click-triggered line (name form / drop confirm) under the row.
 */
import { describe, expect, it, vi } from 'vitest';
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
    registerScoop: vi.fn(async (scoop: RegisteredScoop) => {
      scoops = [...scoops, scoop];
    }),
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
  const line = () => handles.element;
  const buttons = () => Array.from(line().querySelectorAll('button')).map((b) => b.textContent);
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
    line,
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
  it('tells the row how many cones there are and sits right under it', () => {
    const h = harness([primary]);
    expect(h.row.getAttribute('cones')).toBe('1');
    expect(h.row.nextElementSibling).toBe(h.line());
    // Nothing under the row until something is clicked — no hover state at all.
    expect(h.line().childElementCount).toBe(0);
    h.client.registerScoop(research);
    h.handles.refresh();
    expect(h.row.getAttribute('cones')).toBe('2');
  });

  it('new-cone opens a name form; submitting registers a root and selects it once it lands', async () => {
    const h = harness([primary]);
    h.fire('new-cone');
    const input = h.line().querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('New cone name');
    input.value = 'Research';
    input.dispatchEvent(new Event('input'));
    h.line()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(h.client.registerScoop).toHaveBeenCalledOnce());
    const record = h.client.registerScoop.mock.calls[0][0];
    expect(record.parentJid).toBeNull();
    expect(record.name).toBe('Research');
    // Form is gone, the placeholder is not selected…
    expect(h.line().querySelector('form')).toBeNull();
    expect(h.selectScoop).not.toHaveBeenCalled();
    // …the kernel's real record is.
    h.landed(research);
    expect(h.selected?.jid).toBe('cone_2');
  });

  it('ignores an empty name and lets Cancel / a second click close the form', () => {
    const h = harness([primary]);
    h.fire('new-cone');
    h.line()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(h.client.registerScoop).not.toHaveBeenCalled();
    expect(h.line().querySelector('form')).not.toBeNull();
    h.fire('new-cone');
    expect(h.line().querySelector('form')).toBeNull();
    h.fire('new-cone');
    (h.line().querySelector('button[type="button"]') as HTMLButtonElement).click();
    expect(h.line().querySelector('form')).toBeNull();
  });

  it('drop-cone asks first, then freezes the chat and drops the cone', async () => {
    const h = harness([primary, research, child('scoop_1', 'cone_2')]);
    h.select(research);
    h.fire('drop-cone');
    expect(h.line().textContent).toContain('Drop Research?');
    expect(h.buttons()).toEqual(['Drop', 'Cancel']);
    expect(h.client.unregisterScoop).not.toHaveBeenCalled();

    (h.line().querySelector('.danger') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    // Frozen BEFORE the drop, and only that cone.
    expect(h.frozen).toEqual(['cone-research']);
    expect(h.freezeCone.mock.invocationCallOrder[0]).toBeLessThan(
      h.client.unregisterScoop.mock.invocationCallOrder[0]
    );
    // Moved onto the surviving root (the oldest one is the primary).
    expect(h.selected?.jid).toBe('cone_1');
    expect(h.row.getAttribute('cones')).toBe('1');
    expect(h.line().childElementCount).toBe(0);
  });

  it('drops the cone that owns the selected scoop', async () => {
    const helper = child('scoop_1', 'cone_2');
    const h = harness([primary, research, helper]);
    h.select(helper);
    h.fire('drop-cone');
    (h.line().querySelector('.danger') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    expect(h.selected?.jid).toBe('cone_1');
  });

  it('keeps the selection when another cone is dropped', async () => {
    const h = harness([primary, research]);
    h.select(primary);
    // Drop targets the current root, so select research, then confirm from there.
    h.select(research);
    h.fire('drop-cone');
    h.select(primary);
    (h.line().querySelector('.danger') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    expect(h.selectScoop).not.toHaveBeenCalled();
  });

  it('still drops when the freeze fails, but says so', async () => {
    const h = harness([primary, research], { freezeFails: true });
    h.select(research);
    h.fire('drop-cone');
    (h.line().querySelector('.danger') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2'));
    expect(h.warn).toHaveBeenCalledWith('WC cone freeze before drop failed', expect.any(Error));
  });

  it('never drops the last cone, even from a stale confirm', async () => {
    const h = harness([primary, research]);
    h.select(research);
    h.fire('drop-cone');
    // The other cone disappears underneath the open confirm.
    await h.client.unregisterScoop('cone_1');
    h.client.unregisterScoop.mockClear();
    h.handles.refresh();
    expect(h.line().childElementCount).toBe(0);
    expect(h.row.getAttribute('cones')).toBe('1');
    h.fire('drop-cone');
    expect(h.line().childElementCount).toBe(0);
    expect(h.client.unregisterScoop).not.toHaveBeenCalled();
  });
});
