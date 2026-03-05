/**
 * Tests for the message renderer — markdown parsing and syntax highlighting.
 */

import { describe, it, expect } from 'vitest';
import { renderMessageContent, renderToolInput, escapeHtml } from './message-renderer.js';

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<div class="foo">&')).toBe(
      '&lt;div class=&quot;foo&quot;&gt;&amp;',
    );
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#x27;s');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('renderMessageContent', () => {
  it('renders plain text', () => {
    const html = renderMessageContent('Hello world');
    expect(html).toContain('Hello world');
  });

  it('renders inline code', () => {
    const html = renderMessageContent('Use `console.log()` for debugging');
    expect(html).toContain('<code>console.log()</code>');
  });

  it('renders bold text', () => {
    const html = renderMessageContent('This is **bold** text');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    const html = renderMessageContent('This is *italic* text');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders fenced code blocks', () => {
    const content = '```js\nconst x = 1;\n```';
    const html = renderMessageContent(content);
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const');
  });

  it('syntax highlights JS keywords in code blocks', () => {
    const content = '```js\nconst x = 1;\n```';
    const html = renderMessageContent(content);
    expect(html).toContain('tok-keyword');
  });

  it('renders code blocks without a language', () => {
    const content = '```\nplain text\n```';
    const html = renderMessageContent(content);
    expect(html).toContain('<pre><code>');
    expect(html).toContain('plain text');
  });

  it('converts double newlines to paragraph breaks', () => {
    const html = renderMessageContent('First paragraph\n\nSecond paragraph');
    expect(html).toContain('<p>');
    expect(html).toContain('First paragraph');
    expect(html).toContain('Second paragraph');
  });

  it('converts single newlines to br or softbreak', () => {
    const html = renderMessageContent('Line 1\nLine 2');
    // unified renders soft breaks as newlines within a paragraph
    expect(html).toContain('Line 1');
    expect(html).toContain('Line 2');
  });

  it('does not apply inline formatting inside code blocks', () => {
    const content = '```\nconst **x** = 1;\n```';
    const html = renderMessageContent(content);
    // Inside code blocks, ** should be escaped, not turned into <strong>
    expect(html).not.toContain('<strong>x</strong>');
  });

  it('renders GFM tables', () => {
    const content = '| A | B |\n|---|---|\n| 1 | 2 |';
    const html = renderMessageContent(content);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>');
    expect(html).toContain('<td>');
  });

  it('renders GFM strikethrough', () => {
    const html = renderMessageContent('~~deleted~~');
    expect(html).toContain('<del>deleted</del>');
  });
});

describe('renderToolInput', () => {
  it('renders string input', () => {
    expect(renderToolInput('hello')).toBe('hello');
  });

  it('renders object input as JSON', () => {
    const result = renderToolInput({ path: '/foo', content: 'bar' });
    expect(result).toContain('&quot;path&quot;');
    expect(result).toContain('/foo');
  });

  it('renders number input', () => {
    expect(renderToolInput(42)).toContain('42');
  });

  it('handles non-serializable input gracefully', () => {
    const circular: any = {};
    circular.self = circular;
    const result = renderToolInput(circular);
    expect(result).toContain('[object Object]');
  });
});
