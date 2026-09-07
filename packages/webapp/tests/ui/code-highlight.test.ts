/**
 * Tests for the code-block highlighter.
 *
 * The theme running through most of these: the highlighter must tokenize the
 * ORIGINAL source and escape once on the way out. The bug they lock down came
 * from highlighting already-escaped HTML, where `'` is `&#39;` — a five-char
 * sequence ending in a real apostrophe — so string rules matched from the tail
 * of one entity to the tail of the next and a number rule chopped `39` out of
 * the middle of the entity.
 */

import { describe, expect, it } from 'vitest';
import { highlightCode } from '../../src/ui/code-highlight.js';

/** The text a browser would show for `html`, spans removed, entities decoded. */
function rendered(html: string): string {
  return html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The text inside every `tok-<type>` span, in order. */
function spans(html: string, type: string): string[] {
  const matches = html.matchAll(new RegExp(`<span class="tok-${type}">(.*?)</span>`, 'gs'));
  return [...matches].map((m) => rendered(m[1] ?? ''));
}

describe('highlightCode', () => {
  it('escapes markup so a code block can never inject tags', () => {
    const html = highlightCode('<script>alert(1)</script>', 'js');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('round-trips the source exactly', () => {
    const code = 'const a = 1; // <b>&</b>\nconst s = "x\'y";';
    expect(rendered(highlightCode(code, 'js'))).toBe(code);
  });

  it('leaves an unknown language escaped but untokenized', () => {
    const html = highlightCode('let x = 1 <> 2', 'brainfuck');
    expect(html).toBe('let x = 1 &lt;&gt; 2');
  });

  it('escapes shtml without tokenizing it, so dip hydration reads it back', () => {
    const html = highlightCode('<div class="card">const</div>', 'shtml');
    expect(html).not.toContain('tok-');
    expect(html).toContain('&lt;div');
  });

  describe('JS', () => {
    it('highlights keywords, numbers and calls', () => {
      const html = highlightCode('const n = 42;\nrun(n);', 'js');
      expect(spans(html, 'keyword')).toEqual(['const']);
      expect(spans(html, 'number')).toEqual(['42']);
      expect(spans(html, 'fn')).toEqual(['run']);
    });

    // The reported bug: a string whose body contains `<`, `>`, `"` or `&`.
    // Escape-then-highlight made the string body plain and highlighted the
    // gap between two strings instead — delimiters, commas and comments.
    it('highlights a string whose body is markup', () => {
      const code = `const ICONS = {\n  npm: '<svg viewBox="0 0 256"><rect fill="#CB3837"/></svg>', // brand red\n};`;
      const html = highlightCode(code, 'js');

      expect(spans(html, 'string')).toEqual([
        `'<svg viewBox="0 0 256"><rect fill="#CB3837"/></svg>'`,
      ]);
      expect(spans(html, 'comment')).toEqual(['// brand red']);
    });

    it('keeps consecutive markup strings separate instead of spanning the gap', () => {
      const code = `const a = '<b>&amp;</b>';\nconst b = '<i>x</i>';`;
      expect(spans(highlightCode(code, 'js'), 'string')).toEqual([`'<b>&amp;</b>'`, `'<i>x</i>'`]);
    });

    // `\b\d+\b` over escaped HTML matched the `39` inside `&#39;`, splitting
    // the entity into `&#<span…>39</span>;`, which renders as literal `&#39;`.
    it('never splits an escaped quote into a broken character reference', () => {
      const html = highlightCode("const q = 'x';", 'js');
      expect(html).not.toContain('&#<span');
      expect(html).not.toMatch(/&#(?!39;)/);
      expect(rendered(html)).toBe("const q = 'x';");
    });

    it('does not treat a URL inside a string as a comment', () => {
      const html = highlightCode("const u = 'https://example.com/a';", 'js');
      expect(spans(html, 'string')).toEqual([`'https://example.com/a'`]);
      expect(spans(html, 'comment')).toEqual([]);
    });

    it('does not treat an apostrophe inside a comment as a string', () => {
      const html = highlightCode("// it's fine\nconst x = 1;", 'js');
      expect(spans(html, 'comment')).toEqual(["// it's fine"]);
      expect(spans(html, 'string')).toEqual([]);
    });

    it('does not highlight keywords inside strings or comments', () => {
      const html = highlightCode("const a = 'const';\n// const\n", 'js');
      expect(spans(html, 'keyword')).toEqual(['const']);
    });

    it('keeps an escaped quote inside a string in the same token', () => {
      const html = highlightCode("const a = 'it\\'s';", 'js');
      expect(spans(html, 'string')).toEqual(["'it\\'s'"]);
    });

    it('highlights template literals and block comments', () => {
      const html = highlightCode('/* note */ const t = `a ${b} c`;', 'js');
      expect(spans(html, 'comment')).toEqual(['/* note */']);
      expect(spans(html, 'string')).toEqual(['`a ${b} c`']);
    });

    it('produces balanced spans (nothing nested, nothing dangling)', () => {
      const html = highlightCode(
        `const ICONS = { npm: '<svg fill="#CB3837"/>' }; // 1 brand colour`,
        'js'
      );
      const opens = html.match(/<span /g) ?? [];
      const closes = html.match(/<\/span>/g) ?? [];
      expect(opens.length).toBe(closes.length);
      expect(html).not.toMatch(/<span [^>]*><span /);
    });

    it('applies the same rules to ts, tsx, jsx and javascript', () => {
      for (const lang of ['javascript', 'ts', 'typescript', 'jsx', 'tsx']) {
        expect(highlightCode('const x = 1;', lang)).toContain('tok-keyword');
      }
    });
  });

  describe('JSON', () => {
    it('marks keys and values apart', () => {
      const html = highlightCode('{"path": "/foo", "n": 2, "ok": true}', 'json');
      expect(spans(html, 'keyword')).toEqual(['"path"', '"n"', '"ok"', 'true']);
      expect(spans(html, 'string')).toEqual(['"/foo"']);
      expect(spans(html, 'number')).toEqual(['2']);
    });

    it('handles a value containing markup and quotes', () => {
      const html = highlightCode('{"html": "<b class=\\"x\\">&</b>"}', 'json');
      expect(spans(html, 'keyword')).toEqual(['"html"']);
      expect(spans(html, 'string')).toEqual(['"<b class=\\"x\\">&</b>"']);
    });

    it('does not corrupt a colon inside a string value', () => {
      const code = '{"url": "https://x/y"}';
      expect(rendered(highlightCode(code, 'json'))).toBe(code);
    });
  });

  describe('bash', () => {
    // `#` matched the `#` of `&#39;` when rules ran over escaped HTML, so every
    // single-quoted argument turned the rest of the line into a comment.
    it('treats a single-quoted argument as a string, not a comment', () => {
      const html = highlightCode("echo 'hello world'\nls /tmp", 'bash');
      expect(spans(html, 'string')).toEqual([`'hello world'`]);
      expect(spans(html, 'comment')).toEqual([]);
      expect(spans(html, 'keyword')).toEqual(['echo', 'ls']);
    });

    it('highlights a real comment to end of line', () => {
      const html = highlightCode('# set it up\nnpm install', 'bash');
      expect(spans(html, 'comment')).toEqual(['# set it up']);
    });

    it('does not start a comment mid-word', () => {
      const html = highlightCode('echo ${x#prefix}', 'bash');
      expect(spans(html, 'comment')).toEqual([]);
    });

    it('keeps a # inside a double-quoted string out of comment territory', () => {
      const html = highlightCode('echo "color #CB3837"', 'bash');
      expect(spans(html, 'string')).toEqual(['"color #CB3837"']);
      expect(spans(html, 'comment')).toEqual([]);
    });

    it('applies the same rules to sh, shell and zsh', () => {
      for (const lang of ['sh', 'shell', 'zsh']) {
        expect(highlightCode('echo hi', lang)).toContain('tok-keyword');
      }
    });
  });
});
