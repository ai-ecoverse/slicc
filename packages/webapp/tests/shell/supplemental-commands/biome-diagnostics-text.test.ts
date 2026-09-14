import { describe, expect, it } from 'vitest';
import { htmlDiagnosticsToText } from '../../../src/shell/supplemental-commands/biome-diagnostics-text.js';

describe('htmlDiagnosticsToText', () => {
  it('strips nested and attribute-bearing tags', () => {
    expect(
      htmlDiagnosticsToText('<strong>error: <span style="color: red">unexpected</span></strong>')
    ).toBe('error: unexpected');
  });

  it('decodes named and numeric entities', () => {
    expect(
      htmlDiagnosticsToText('&amp; &lt; &gt; &quot; &#39; &nbsp; &#65; &#x42; &#x1F642;')
    ).toBe('& < > " \'   A B 🙂');
  });

  it('preserves line breaks and block structure', () => {
    const html = '<div>first<br>second<br/>third</div><p>fourth</p><ul><li>fifth</li></ul>';
    expect(htmlDiagnosticsToText(html)).toBe('first\nsecond\nthird\nfourth\nfifth');
  });

  it('passes already-plain text through unchanged', () => {
    const plain = 'error: a & b\n  at file.ts:1:2\n';
    expect(htmlDiagnosticsToText(plain)).toBe(plain);
    expect(htmlDiagnosticsToText(htmlDiagnosticsToText(plain))).toBe(plain);
  });

  it('does not throw on malformed HTML or invalid numeric entities', () => {
    const malformed = '<strong>broken &amp; <span class="location" &#99999999;';
    expect(() => htmlDiagnosticsToText(malformed)).not.toThrow();
    expect(htmlDiagnosticsToText(malformed)).toBe('broken & <span class="location" &#99999999;');
  });

  it('does not emit ANSI escape sequences', () => {
    const text = htmlDiagnosticsToText('<span style="color: red">error</span>');
    expect(text).toBe('error');
    expect(text).not.toContain('\u001b');
  });
});
