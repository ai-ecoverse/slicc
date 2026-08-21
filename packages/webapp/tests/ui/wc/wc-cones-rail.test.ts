// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { buildNewConeRecord, wireConesRail } from '../../../src/ui/wc/wc-cones-rail.js';
import { DEFAULT_ROOT_STORAGE_KEY } from '../../../src/work-unit/default-root.js';
import {
  type FakeLocalStorage,
  installFakeLocalStorage,
} from '../../helpers/fake-local-storage.js';

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

function harness(initial: RegisteredScoop[]) {
  let scoops = [...initial];
  let selected: RegisteredScoop | null = scoops[0] ?? null;
  const freezer = document.createElement('div');
  const switcher = document.createElement('div');
  document.body.append(freezer, switcher);
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
    switcher.setAttribute('active', scoop.jid);
  });
  const handles = wireConesRail({
    refs: { freezer, switcher },
    client,
    getSelected: () => selected,
    selectScoop,
    log: { warn: vi.fn() },
  });
  const rows = () => Array.from(handles.element.querySelectorAll<HTMLElement>('.row'));
  const stars = () => rows().map((r) => r.querySelector<HTMLElement>('.def'));
  const labels = () => rows().map((r) => r.querySelector('.lbl')?.textContent);
  const click = (el: Element | null | undefined) =>
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { handles, client, selectScoop, rows, stars, labels, click, freezer, switcher };
}

const primary = root('cone_1', 'cone', 'sliccy', '2026-01-01T00:00:00.000Z');
const research = root('cone_2', 'cone-research', 'Research', '2026-01-02T00:00:00.000Z');

describe('wireConesRail', () => {
  let storage: FakeLocalStorage;

  beforeEach(() => {
    storage = installFakeLocalStorage();
  });
  afterEach(() => {
    storage.restore();
  });

  it('renders one row per root, marks the selected one, hides ✕ on the last root', () => {
    const h = harness([primary, child('w', 'cone_1')]);
    expect(h.labels()).toEqual(['sliccy']);
    expect(h.rows()[0].getAttribute('aria-current')).toBe('true');
    expect(h.handles.element.querySelector('.rm')).toBeNull();
    expect(h.handles.element.querySelector('.add')).not.toBeNull();
  });

  it('switches roots on row click and follows the switcher active attribute', async () => {
    const h = harness([primary, research]);
    expect(h.labels()).toEqual(['sliccy', 'Research']);
    h.click(h.rows()[1]);
    expect(h.selectScoop).toHaveBeenCalledWith(research);
    await Promise.resolve();
    h.handles.refresh();
    expect(h.rows().map((r) => r.getAttribute('aria-current'))).toEqual(['false', 'true']);
  });

  it('asks for a name, then registers an optimistic root record', () => {
    const h = harness([primary]);
    h.click(h.handles.element.querySelector('.add'));
    const input = h.handles.element.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    // empty names are ignored
    h.handles.element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(h.client.registerScoop).not.toHaveBeenCalled();
    input!.value = 'Research';
    input!.dispatchEvent(new Event('input'));
    h.handles.element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(h.client.registerScoop).toHaveBeenCalledOnce();
    const record = h.client.registerScoop.mock.calls[0][0];
    expect(record).toMatchObject({
      parentJid: null,
      isCone: true,
      name: 'Research',
      assistantLabel: 'Research',
    });
    expect(record.folder).toMatch(/^cone-pending-/);
    // the form closed again
    expect(h.handles.element.querySelector('input')).toBeNull();
    // the optimistic placeholder is not selected; the kernel's real record is
    expect(h.selectScoop).not.toHaveBeenCalled();
    h.client.getScoops = () => [primary, { ...research, name: 'Research' }];
    h.handles.refresh();
    expect(h.selectScoop).toHaveBeenCalledWith(expect.objectContaining({ jid: 'cone_2' }));
    h.handles.refresh();
    expect(h.selectScoop).toHaveBeenCalledOnce();
  });

  it('removes a root only after the inline confirm, and reselects another root', () => {
    const h = harness([primary, research, child('w', 'cone_2')]);
    h.selectScoop(research);
    h.handles.refresh();
    const rm = h.rows()[1].querySelector('.rm');
    expect(rm).not.toBeNull();
    h.click(rm);
    expect(h.client.unregisterScoop).not.toHaveBeenCalled();
    expect(h.handles.element.querySelector('.confirm')).not.toBeNull();
    // cancel keeps everything
    h.click(h.handles.element.querySelector('.confirm button:not(.danger)'));
    expect(h.handles.element.querySelector('.confirm')).toBeNull();
    h.click(h.rows()[1].querySelector('.rm'));
    h.click(h.handles.element.querySelector('.confirm .danger'));
    expect(h.client.unregisterScoop).toHaveBeenCalledWith('cone_2');
    expect(h.selectScoop).toHaveBeenLastCalledWith(primary);
    expect(h.labels()).toEqual(['sliccy']);
    expect(h.handles.element.querySelector('.rm')).toBeNull();
  });

  it('never removes the last cone even through a stale confirm', () => {
    const h = harness([primary, research]);
    h.click(h.rows()[1].querySelector('.rm'));
    const danger = h.handles.element.querySelector<HTMLButtonElement>('.confirm .danger')!;
    // the other cone disappears underneath (e.g. dropped by the agent) …
    h.client.getScoops = () => [primary];
    // … and the stale confirm is clicked: nothing is removed
    h.click(danger);
    expect(h.client.unregisterScoop).not.toHaveBeenCalled();
    expect(h.labels()).toEqual(['sliccy']);
    expect(h.handles.element.querySelector('.rm')).toBeNull();
  });

  it('mirrors the rail open state and re-renders on roster refresh', () => {
    const h = harness([primary]);
    expect(h.handles.element.hasAttribute('expanded')).toBe(false);
    h.freezer.dispatchEvent(new CustomEvent('freezer-toggle', { detail: { open: true } }));
    expect(h.handles.element.hasAttribute('expanded')).toBe(true);
    h.client.getScoops = () => [primary, research];
    h.handles.refresh();
    expect(h.labels()).toEqual(['sliccy', 'Research']);
  });

  it('stars the cone unaddressed events reach and moves the star on click (#2273)', () => {
    const h = harness([primary, research]);
    // Unset → the primary cone holds it; the star is a toggle among cones,
    // so the one that already has it is inert.
    expect(h.stars().map((s) => s?.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    h.click(h.stars()[0]);
    expect(storage.store.get(DEFAULT_ROOT_STORAGE_KEY)).toBeUndefined();

    h.click(h.stars()[1]);
    expect(storage.store.get(DEFAULT_ROOT_STORAGE_KEY)).toBe(research.jid);
    expect(h.stars().map((s) => s?.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    // Picking a default must not switch the active chat.
    expect(h.selectScoop).not.toHaveBeenCalled();
  });

  it('offers no star while there is only one cone', () => {
    expect(harness([primary]).stars()).toEqual([null]);
  });

  it('forgets the pick when the cone holding it is removed', () => {
    const h = harness([primary, research]);
    h.click(h.stars()[1]);
    h.click(h.rows()[1].querySelector('.rm'));
    h.click(h.handles.element.querySelector('.confirm .danger'));
    expect(h.client.unregisterScoop).toHaveBeenCalledWith(research.jid);
    expect(storage.store.get(DEFAULT_ROOT_STORAGE_KEY)).toBeUndefined();
  });

  it('buildNewConeRecord produces a root placeholder with the typed name', () => {
    const record = buildNewConeRecord('Ops', [primary]);
    expect(record.parentJid).toBeNull();
    expect(record.isCone).toBe(true);
    expect(record.assistantLabel).toBe('Ops');
    expect(record.folder).toBe('cone-pending-2');
  });
});
