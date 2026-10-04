// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ariaRefLookupExpression,
  ariaRefRectsExpression,
  ariaSnapshotExpression,
} from '../../src/cdp/injected-aria-snapshot.js';

interface RawNode {
  role: string;
  name: string;
  ref?: string;
  refSeq?: number;
  children?: RawNode[];
}

function run<T>(expression: string): T {
  return new Function(`return (${expression});`)() as T;
}

function snapshot(refFloor = 0): RawNode {
  return run<RawNode>(ariaSnapshotExpression(refFloor));
}

function refsByLabel(tree: RawNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: RawNode): void => {
    if (node.ref) out.set(`${node.role} "${node.name}"`, node.ref);
    node.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

function forgetStore(): void {
  delete (window as unknown as Record<symbol, unknown>)[Symbol.for('slicc.ariaRefs')];
}

describe('injected aria snapshot refs', () => {
  const realGetComputedStyle = window.getComputedStyle;
  beforeAll(() => {
    window.getComputedStyle = ((el: Element, pseudo?: string | null) =>
      pseudo
        ? ({ content: 'none' } as CSSStyleDeclaration)
        : realGetComputedStyle.call(window, el)) as typeof window.getComputedStyle;
  });
  afterAll(() => {
    window.getComputedStyle = realGetComputedStyle;
  });

  beforeEach(() => {
    forgetStore();
    document.body.innerHTML = '';
  });

  it('keeps existing refs when the page inserts an element above them', () => {
    document.body.innerHTML = `
      <input aria-label="Auftragsnummer" id="order">
      <span id="anchor"></span>
      <label>Nachname der reisenden Person</label>
      <input aria-label="Nachname der reisenden Person">
      <button>Suchen</button>`;
    const before = refsByLabel(snapshot());

    const clear = document.createElement('button');
    clear.textContent = 'Eingabe löschen';
    document.getElementById('anchor')!.replaceWith(clear);
    const after = refsByLabel(snapshot());

    expect(after.get('textbox "Auftragsnummer"')).toBe(before.get('textbox "Auftragsnummer"'));
    expect(after.get('textbox "Nachname der reisenden Person"')).toBe(
      before.get('textbox "Nachname der reisenden Person"')
    );
    expect(after.get('button "Suchen"')).toBe(before.get('button "Suchen"'));

    const fresh = after.get('button "Eingabe löschen"')!;
    expect([...before.values()]).not.toContain(fresh);
  });

  it('mints a new ref when an element changes its accessible name', () => {
    document.body.innerHTML = '<button id="b">Show more</button>';
    const first = refsByLabel(snapshot()).get('button "Show more"');
    document.getElementById('b')!.textContent = 'Show less';
    const second = refsByLabel(snapshot()).get('button "Show less"');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('gives same-named elements distinct refs that each resolve to their own element', () => {
    document.body.innerHTML = '<button id="a">BUY</button><button id="b">BUY</button>';
    const tree = snapshot();
    const refs = tree.children!.map((c) => c.ref!);
    expect(new Set(refs).size).toBe(2);
    expect(run<Element>(ariaRefLookupExpression(refs[0])).id).toBe('a');
    expect(run<Element>(ariaRefLookupExpression(refs[1])).id).toBe('b');
  });

  it('does not ref plain text, generic containers, or unnamed non-control roles', () => {
    document.body.innerHTML = '<div><p>hello</p><ul><li>one</li></ul></div>';
    expect(refsByLabel(snapshot()).size).toBe(0);
  });

  it('always refs iframes so stitched frame refs hang off a stable element', () => {
    document.body.innerHTML = '<iframe src="about:blank"></iframe>';
    expect(refsByLabel(snapshot()).get('iframe ""')).toMatch(/^e[0-9]+$/);
  });

  it('starts a new document above the floor so old refs never come back', () => {
    document.body.innerHTML = '<button>Next</button>';
    const tree = snapshot(41);
    expect(tree.children![0].ref).toBe('e42');
    expect(tree.refSeq).toBe(42);
  });

  it('keeps counting from its own counter when it is ahead of the floor', () => {
    document.body.innerHTML = '<button>One</button>';
    snapshot(10);
    document.body.innerHTML = '<button>Two</button>';
    expect(snapshot(0).children![0].ref).toBe('e12');
  });

  it('returns null for refs whose element left the DOM or that were never minted', () => {
    document.body.innerHTML = '<button id="gone">Gone</button>';
    const ref = snapshot().children![0].ref!;
    document.getElementById('gone')!.remove();
    expect(run(ariaRefLookupExpression(ref))).toBeNull();
    expect(run(ariaRefLookupExpression('e999'))).toBeNull();
    forgetStore();
    expect(run(ariaRefLookupExpression(ref))).toBeNull();
  });

  it('drops refs that are no longer in the latest snapshot from the lookup table', () => {
    document.body.innerHTML = '<button id="b">Toggle</button>';
    const ref = snapshot().children![0].ref!;
    (document.getElementById('b') as HTMLElement).hidden = true;
    snapshot();
    expect(run(ariaRefLookupExpression(ref))).toBeNull();
  });

  it('gives an element its old ref back when it reappears unchanged', () => {
    document.body.innerHTML = '<button id="b">Menu</button>';
    const ref = snapshot().children![0].ref!;
    const el = document.getElementById('b') as HTMLElement;
    el.hidden = true;
    snapshot();
    el.hidden = false;
    expect(snapshot().children![0].ref).toBe(ref);
  });

  it('reports rects only for live refs', () => {
    document.body.innerHTML = '<button>Keep</button><button id="x">Drop</button>';
    const [keep, drop] = snapshot().children!.map((c) => c.ref!);
    document.getElementById('x')!.remove();
    const rects = run<Record<string, number[]>>(ariaRefRectsExpression([keep, drop]));
    expect(Object.keys(rects)).toEqual([keep]);
    expect(rects[keep]).toHaveLength(4);
  });
});
