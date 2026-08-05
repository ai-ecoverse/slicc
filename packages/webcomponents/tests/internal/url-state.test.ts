import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/chat/slicc-chat-thread.js';
import { readUrlState, writeUrlState } from '../../src/internal/url-state.js';

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
