import { beforeEach, describe, expect, it } from 'vitest';
import '../../src/chat/slicc-action-row.js';
import { SliccToolCluster } from '../../src/chat/slicc-tool-cluster.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mountWithRows(rows = 3): SliccToolCluster {
  const el = document.createElement('slicc-tool-cluster') as SliccToolCluster;
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('slicc-action-row');
    row.setAttribute('label', `step ${i + 1}`);
    el.append(row);
  }
  document.body.appendChild(el);
  return el;
}

describe('slicc-tool-cluster', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tool-cluster')).toBe(SliccToolCluster);
  });

  it('relocates wrapped rows into the body and collapses them by default', () => {
    const el = mountWithRows(3);
    const body = el.querySelector('.slicc-cluster__body') as HTMLElement;
    expect(body.querySelectorAll('slicc-action-row')).toHaveLength(3);
    expect(el.open).toBe(false);
    expect(getComputedStyle(body).display).toBe('none');
  });

  it('expands on header click, rotating the chevron and firing the toggle event', () => {
    const el = mountWithRows(3);
    const toggles: boolean[] = [];
    el.addEventListener('slicc-tool-cluster-toggle', (e) =>
      toggles.push((e as CustomEvent<{ open: boolean }>).detail.open)
    );

    (el.querySelector('.slicc-cluster__head') as HTMLElement).click();
    expect(el.open).toBe(true);
    expect(getComputedStyle(el.querySelector('.slicc-cluster__body') as Element).display).toBe(
      'block'
    );

    (el.querySelector('.slicc-cluster__head') as HTMLElement).click();
    expect(el.open).toBe(false);
    expect(toggles).toEqual([true, false]);
  });

  it('shows the label (with a generic fallback) and a derived step count', () => {
    const el = mountWithRows(4);
    const label = el.querySelector('.slicc-cluster__label') as HTMLElement;
    const count = el.querySelector('.slicc-cluster__count') as HTMLElement;
    expect(label.textContent).toBe('A few quick steps');
    expect(count.textContent).toBe('4 steps');

    el.setAttribute('label', 'Figure out how to push to a branch');
    el.setAttribute('count', '5');
    expect(label.textContent).toBe('Figure out how to push to a branch');
    expect(count.textContent).toBe('5 steps');
  });

  it('escapes interpolated label text', () => {
    const el = mountWithRows(3);
    el.setAttribute('label', '<img src=x onerror=alert(1)>');
    const label = el.querySelector('.slicc-cluster__label') as HTMLElement;
    expect(label.querySelector('img')).toBeNull();
    expect(label.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
