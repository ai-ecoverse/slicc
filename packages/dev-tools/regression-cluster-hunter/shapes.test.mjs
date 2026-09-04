import { describe, expect, it } from 'vitest';
import { matchShapes, probeShape, renderShapes, SHAPES } from './shapes.mjs';

const byId = (id) => SHAPES.find((s) => s.id === id);

describe('the catalog', () => {
  it('every shape carries its receipt', () => {
    // A shape without a recorded cluster is a guess, and a guessed probe turns
    // the sweep into a grep dump.
    for (const s of SHAPES) {
      expect(s.evidence, s.id).toMatch(/#\d+/);
      expect(s.rule.length, s.id).toBeGreaterThan(40);
      expect(typeof s.detect, s.id).toBe('function');
      expect(typeof s.probe, s.id).toBe('function');
    }
  });

  it('has unique ids', () => {
    expect(new Set(SHAPES.map((s) => s.id)).size).toBe(SHAPES.length);
  });
});

describe('matchShapes', () => {
  it('recognises the #2818 binary-encoding fix', () => {
    const diff = '-  const latin1 = bytesToLatin1(bytes); // binary bodies corrupt';
    expect(matchShapes(diff).map((s) => s.id)).toContain('binary-encoding-hop');
  });

  it('does not fire on an unrelated diff that merely says utf-8', () => {
    expect(matchShapes('-  const enc = "utf-8";').map((s) => s.id)).not.toContain(
      'binary-encoding-hop'
    );
  });

  it('recognises the read-modify-write-swallow family', () => {
    const diff = "-  const prior = await readFile(p).catch(() => '');";
    expect(matchShapes(diff).map((s) => s.id)).toContain('read-modify-write-swallow');
  });

  it('recognises the silent-flag family', () => {
    const diff = '+  throw new Error(`unknown flag ${arg}`);';
    expect(matchShapes(diff).map((s) => s.id)).toContain('silent-unknown-flag');
  });

  it('returns nothing for an empty or unrelated diff', () => {
    expect(matchShapes('')).toEqual([]);
    expect(matchShapes(null)).toEqual([]);
    expect(matchShapes('-  renderButton();')).toEqual([]);
  });

  it('survives a shape whose detector throws', () => {
    expect(() => matchShapes('x'.repeat(50_000))).not.toThrow();
  });
});

describe('binary-encoding-hop probe', () => {
  const shape = byId('binary-encoding-hop');

  it('flags reading base64Encoded without ever decoding it', () => {
    // The #2887 shape: the bug is a MISSING decode, so there is no wrong call
    // to grep for.
    const r = shape.probe('if (res.base64Encoded) { save(res.body); }', 'a/network.ts');
    expect(r.precise).toBe(true);
    expect(r.why.join()).toMatch(/never decodes base64/);
  });

  it('does not flag a file that decodes what it reads', () => {
    const r = shape.probe('if (res.base64Encoded) { save(atob(res.body)); }', 'a/network.ts');
    expect(r.precise).toBe(false);
  });

  it('flags a file that both carries bytes and converts text', () => {
    const r = shape.probe('const b = new Uint8Array(x); new TextDecoder().decode(b);', 'a/git.ts');
    expect(r.hits).toBeGreaterThan(0);
  });

  it('ignores a file that only converts text and carries no bytes', () => {
    expect(shape.probe('new TextDecoder().decode(s)', 'a/label.ts').hits).toBe(0);
  });

  it('treats a dedicated codec as non-incidental', () => {
    const src = 'const b = new Uint8Array(x); new TextDecoder().decode(b); atob(y); btoa(z);';
    expect(shape.probe(src, 'packages/shared-ts/src/base64.ts').incidental).toBe(false);
    expect(shape.probe(src, 'packages/webapp/src/cdp/har-recorder.ts').incidental).toBe(false);
  });

  it('treats incidental byte-handling as incidental', () => {
    const r = shape.probe(
      'const b = new Uint8Array(x); new TextDecoder().decode(b);',
      'a/mouse.ts'
    );
    expect(r.incidental).toBe(true);
  });
});

describe('read-modify-write-swallow probe', () => {
  const shape = byId('read-modify-write-swallow');

  it('flags the read-default-write triad', () => {
    const src = `
      async function append(entry) {
        let prior = [];
        try { prior = JSON.parse(await readFile(P, 'utf8')); } catch { return []; }
        await writeFile(P, JSON.stringify([...prior, entry]));
      }`;
    const r = shape.probe(src);
    expect(r.precise).toBe(true);
  });

  it('ignores a read that never writes back', () => {
    const src = "try { return await readFile(P, 'utf8'); } catch { return ''; }";
    expect(shape.probe(src).hits).toBe(0);
  });

  it('ignores a file that does not read at all', () => {
    expect(shape.probe('await writeFile(P, x);').hits).toBe(0);
  });
});

describe('silent-unknown-flag probe', () => {
  const shape = byId('silent-unknown-flag');

  it('flags a parser with no unknown-flag branch', () => {
    const r = shape.probe("for (const a of argv) { if (a.startsWith('--verbose')) v = true; }");
    expect(r.precise).toBe(true);
  });

  it('clears a parser that rejects unknown flags', () => {
    const src = `for (const a of argv) {
      if (a.startsWith('--verbose')) v = true;
      else throw new Error('unknown flag: ' + a);
    }`;
    expect(shape.probe(src).hits).toBe(0);
  });

  it('ignores a file that parses nothing', () => {
    expect(shape.probe('export const x = 1;').hits).toBe(0);
  });
});

describe('probeShape', () => {
  const shape = byId('binary-encoding-hop');
  const sources = new Map([
    ['packages/webapp/src/cdp/har-recorder.ts', 'res.base64Encoded ? body : body'],
    ['packages/webapp/src/git/stash.ts', 'new Uint8Array(x); new TextDecoder().decode(x);'],
    ['packages/shared-ts/src/base64.ts', 'new Uint8Array(x); atob(y); btoa(z); "utf-8";'],
    ['packages/webapp/src/ui/label.ts', 'const t = "hello";'],
  ]);

  it('ranks a precise signal above bulk vocabulary', () => {
    const ranked = probeShape(shape, sources, []);
    expect(ranked[0].file).toBe('packages/webapp/src/cdp/har-recorder.ts');
    expect(ranked[0].precise).toBe(true);
  });

  it('excludes the files the fix already repaired', () => {
    const ranked = probeShape(shape, sources, ['packages/webapp/src/cdp/har-recorder.ts']);
    expect(ranked.map((r) => r.file)).not.toContain('packages/webapp/src/cdp/har-recorder.ts');
  });

  it('drops files below the hit floor', () => {
    expect(probeShape(shape, sources, []).map((r) => r.file)).not.toContain(
      'packages/webapp/src/ui/label.ts'
    );
  });

  it('honours the cap', () => {
    const many = new Map(
      Array.from({ length: 40 }, (_, i) => [
        `packages/webapp/src/f${i}.ts`,
        'new Uint8Array(x); new TextDecoder().decode(x); btoa(y);',
      ])
    );
    expect(probeShape(shape, many, [], { max: 5 }).length).toBe(5);
  });

  it('accepts a Set of exclusions as well as an array', () => {
    const ranked = probeShape(shape, sources, new Set(['packages/webapp/src/cdp/har-recorder.ts']));
    expect(ranked.map((r) => r.file)).not.toContain('packages/webapp/src/cdp/har-recorder.ts');
  });
});

describe('renderShapes', () => {
  it('renders the rule, the receipt and the hits', () => {
    const shape = byId('binary-encoding-hop');
    const out = renderShapes(
      [shape],
      new Map([[shape.id, [{ file: 'a/b.ts', hits: 4, why: ['carries bytes'] }]]])
    );
    expect(out).toContain('The rule to test each candidate against');
    expect(out).toContain('#2818');
    expect(out).toContain('`a/b.ts`');
  });

  it('says so plainly when a shape has no other home', () => {
    const shape = byId('binary-encoding-hop');
    expect(renderShapes([shape], new Map())).toContain('nothing else in the tree smells of this');
  });

  it('renders nothing when no shape matched', () => {
    expect(renderShapes([], new Map())).toBe('');
  });
});
