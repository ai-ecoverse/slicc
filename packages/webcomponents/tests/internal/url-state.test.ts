import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/chat/slicc-chat-thread.js';
import '../../src/dock/slicc-dock.js';
import { readUrlState, writeUrlState } from '../../src/internal/url-state.js';
import '../../src/shell/slicc-shell.js';

function param(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

function clearParams(): void {
  const url = new URL(window.location.href);
  url.search = '';
  history.replaceState(null, '', url);
}

describe('url-state helper', () => {
  beforeEach(clearParams);
  afterEach(clearParams);

  it('round-trips params via replaceState by default', () => {
    expect(readUrlState('ws')).toBeNull();
    const depth = history.length;
    writeUrlState('ws', 'files');
    expect(param('ws')).toBe('files');
    expect(readUrlState('ws')).toBe('files');
    expect(history.length).toBe(depth);
    writeUrlState('ws', null);
    expect(param('ws')).toBeNull();
  });

  it('push:true records a history entry; no-op writes never push', () => {
    writeUrlState('ctx', 'cone', { push: true });
    const depth = history.length;
    // Same value again — skipped entirely (apply-from-URL must not re-push).
    writeUrlState('ctx', 'cone', { push: true });
    expect(history.length).toBe(depth);
    writeUrlState('ctx', 'scoop:researcher', { push: true });
    expect(param('ctx')).toBe('scoop:researcher');
  });

  it('preserves unrelated params', () => {
    writeUrlState('tray', 'https://x.example/t/1');
    writeUrlState('ws', 'term');
    expect(param('tray')).toBe('https://x.example/t/1');
    expect(param('ws')).toBe('term');
  });
});

describe('slicc-chat-thread url-state', () => {
  beforeEach(() => {
    clearParams();
    document.body.replaceChildren();
  });
  afterEach(clearParams);

  it('persists context changes to the ctx param (opt-in only)', () => {
    const plain = document.createElement('slicc-chat-thread');
    document.body.appendChild(plain);
    plain.setAttribute('context', 'cone');
    expect(param('ctx')).toBeNull(); // no opt-in, no write

    const el = document.createElement('slicc-chat-thread');
    el.setAttribute('url-state', '');
    document.body.appendChild(el);
    el.setAttribute('context', 'scoop:researcher');
    expect(param('ctx')).toBe('scoop:researcher');
  });

  it('restores the at scroll position across boot reloads until content goes live', async () => {
    writeUrlState('at', '120');
    const el = document.createElement('slicc-chat-thread');
    el.setAttribute('url-state', '');
    el.style.cssText = 'display:block;height:200px;overflow-y:auto;';
    document.body.appendChild(el);
    const load = (): void => {
      const tall = document.createElement('div');
      tall.style.cssText = 'height:1000px;';
      (el as HTMLElement & { replaceContent(...n: Node[]): void }).replaceContent(tall);
    };
    const frame = (): Promise<null> => new Promise((r) => requestAnimationFrame(() => r(null)));

    load();
    await frame();
    expect(el.scrollTop).toBe(120);

    // Boot loads twice (optimistic hydration, then the canonical replay) —
    // the restore re-applies rather than being consumed by the first load.
    load();
    await frame();
    expect(el.scrollTop).toBe(120);

    // Live appended content marks the restore stale: back to bottom-follow.
    const live = document.createElement('div');
    live.style.cssText = 'height:50px;';
    el.append(live);
    load();
    await frame();
    expect(el.scrollTop).toBeGreaterThan(700);
  });

  it('drops the restored position when the context switches away from the boot context', async () => {
    writeUrlState('ctx', 'scoop:researcher');
    writeUrlState('at', '120');
    const el = document.createElement('slicc-chat-thread');
    el.setAttribute('url-state', '');
    el.setAttribute('context', 'cone');
    el.style.cssText = 'display:block;height:200px;overflow-y:auto;';
    document.body.appendChild(el);
    expect((el as HTMLElement & { urlContext: string | null }).urlContext).toBe('scoop:researcher');

    // Boot routes TO the boot context — the restore survives that switch…
    el.setAttribute('context', 'scoop:researcher');
    const tall = document.createElement('div');
    tall.style.cssText = 'height:1000px;';
    (el as HTMLElement & { replaceContent(...n: Node[]): void }).replaceContent(tall);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(el.scrollTop).toBe(120);

    // …but switching AWAY drops it.
    el.setAttribute('context', 'cone');
    const tall2 = document.createElement('div');
    tall2.style.cssText = 'height:1000px;';
    (el as HTMLElement & { replaceContent(...n: Node[]): void }).replaceContent(tall2);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(el.scrollTop).toBeGreaterThan(700);
  });

  it('asks the host to route a popstate context via slicc-url-context', () => {
    const el = document.createElement('slicc-chat-thread');
    el.setAttribute('url-state', '');
    el.setAttribute('context', 'cone');
    document.body.appendChild(el);

    const routed: string[] = [];
    el.addEventListener('slicc-url-context', (e) =>
      routed.push((e as CustomEvent<{ context: string }>).detail.context)
    );
    writeUrlState('ctx', 'scoop:researcher');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(routed).toEqual(['scoop:researcher']);
  });
});

describe('slicc-shell url-state', () => {
  beforeEach(() => {
    clearParams();
    document.body.replaceChildren();
  });
  afterEach(clearParams);

  it('persists the active surface on canonical dock events and clears on collapse', () => {
    const shell = document.createElement('slicc-shell');
    shell.setAttribute('url-state', '');
    document.body.appendChild(shell);

    shell.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'files' } })
    );
    expect(param('ws')).toBe('files');
    shell.dispatchEvent(new CustomEvent('slicc-dock-collapse', { bubbles: true }));
    expect(param('ws')).toBeNull();
  });

  it('reflects the urlState property to the attribute on shell and thread', () => {
    const shell = document.createElement('slicc-shell');
    shell.urlState = true;
    expect(shell.hasAttribute('url-state')).toBe(true);
    shell.urlState = false;
    expect(shell.hasAttribute('url-state')).toBe(false);
    const thread = document.createElement('slicc-chat-thread');
    thread.urlState = true;
    expect(thread.hasAttribute('url-state')).toBe(true);
    expect(thread.urlContext).toBeNull();
  });

  it('re-applies the workspace on popstate and collapses when the param is gone', () => {
    const shell = document.createElement('slicc-shell');
    shell.setAttribute('url-state', '');
    const dock = document.createElement('slicc-dock');
    dock.setAttribute('system-tools', '');
    shell.append(dock);
    document.body.appendChild(shell);

    // Forward into a state with an open workspace: the dock re-selects.
    writeUrlState('ws', 'files');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(dock.getAttribute('active')).toBe('files');

    // Back to a state without one: the shell collapses AND the dock unlights.
    shell.setAttribute('open', '');
    writeUrlState('ws', null);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(shell.hasAttribute('open')).toBe(false);
    expect(dock.getAttribute('active')).toBeNull();
  });

  it('restores a URL workspace by driving the dock selection on connect', async () => {
    writeUrlState('ws', 'term');
    const shell = document.createElement('slicc-shell');
    shell.setAttribute('url-state', '');
    const dock = document.createElement('slicc-dock');
    dock.setAttribute('system-tools', '');
    shell.append(dock);
    document.body.appendChild(shell);

    // The microtask-deferred restore calls dock.selectItem('term'), which
    // re-emits the canonical event every host wires.
    const selected: string[] = [];
    shell.addEventListener('slicc-dock-select', (e) =>
      selected.push((e as CustomEvent<{ id: string }>).detail.id)
    );
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(selected).toEqual(['term']);
    expect(dock.getAttribute('active')).toBe('term');
  });
});
