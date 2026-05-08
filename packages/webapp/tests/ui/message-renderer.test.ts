/**
 * Tests for the message renderer — markdown parsing and syntax highlighting.
 */

import { describe, it, expect } from 'vitest';
import {
  renderAssistantMessageContent,
  renderMessageContent,
  renderToolInput,
  escapeHtml,
} from '../../src/ui/message-renderer.js';

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<div class="foo">&')).toBe('&lt;div class=&quot;foo&quot;&gt;&amp;');
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

  it('renders links that open in a new tab with safe rel attributes', () => {
    const html = renderMessageContent('[Example](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('applies new-tab behavior to sanitized raw HTML links', () => {
    const html = renderMessageContent('<a href="https://example.com">Example</a>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('applies safe link attributes to GFM autolink bare URLs', () => {
    const html = renderMessageContent('Visit https://example.com for details');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('replaces author-supplied rel tokens on raw HTML links', () => {
    const html = renderMessageContent(
      '<a href="https://example.com" rel="opener external">Example</a>'
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/\bopener\b/);
    expect(html).not.toMatch(/\bexternal\b/);
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

  it('does not corrupt syntax highlighting HTML when JS includes export-from statements', () => {
    const content = [
      '```js',
      '// index.js',
      "export { DataChunks } from './distiller.js';",
      "export { pageViews, lcp } from './series.js';",
      "export { url, userAgent } from './facets.js';",
      '```',
    ].join('\n');

    const html = renderMessageContent(content);

    expect(html).toContain('<span class="tok-comment">// index.js</span>');
    expect(html).toContain('<span class="tok-string">\'./distiller.js\'</span>');
    expect(html).not.toContain('<span <span class="tok-keyword">class</span>=');
    expect(html).not.toContain('<span class="tok-keyword">class</span>="tok-comment"&gt;');
    expect(html).not.toContain('<span class="tok-keyword">from</span> class="tok-string"&gt;');
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

  it('converts single newlines to br (remark-breaks)', () => {
    const html = renderMessageContent('Line 1\nLine 2');
    expect(html).toContain('<br>');
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

  describe('XSS sanitization', () => {
    it('strips script tags', () => {
      const html = renderMessageContent('<script>alert(1)</script>');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert(1)');
    });

    it('strips onerror attributes', () => {
      const html = renderMessageContent('<img src="x" onerror="alert(1)">');
      expect(html).not.toContain('onerror');
    });

    it('strips javascript: hrefs', () => {
      const html = renderMessageContent('[click](javascript:alert(1))');
      expect(html).not.toContain('javascript:');
    });

    it('preserves tok-* spans from syntax highlighting', () => {
      const html = renderMessageContent('```js\nconst x = 1;\n```');
      expect(html).toContain('tok-keyword');
    });
  });
});

describe('renderAssistantMessageContent', () => {
  it('renders surfaced assistant errors as dedicated error blocks', () => {
    const html = renderAssistantMessageContent(
      '**Error:** Bedrock CAMP API error (503): {"message":"Bedrock is unable to process your request."}'
    );

    expect(html).toContain('class="msg__error"');
    expect(html).toContain('class="msg__error-label">Error</div>');
    expect(html).toContain('Bedrock CAMP API error (503)');
    expect(html).not.toContain('<strong>Error:</strong>');
  });

  it('preserves normal assistant prose while upgrading appended surfaced errors', () => {
    const html = renderAssistantMessageContent(
      'Trying again now.\n\n**Error:** Provider timeout after 30s'
    );

    expect(html).toContain('<p>Trying again now.</p>');
    expect(html).toContain('class="msg__error"');
    expect(html).toContain('Provider timeout after 30s');
  });

  describe('streaming dip placeholder', () => {
    const finishedShtml = 'Here you go:\n\n```shtml\n<div class="card">Hi</div>\n```\n\nDone.';

    it('replaces a closed shtml fenced block with the pending placeholder while streaming', () => {
      const html = renderAssistantMessageContent(finishedShtml, true);

      expect(html).toContain('class="msg__dip-pending"');
      expect(html).toContain('Pouring a dip…');
      expect(html).not.toContain('class="language-shtml"');
      expect(html).not.toContain('&lt;div class="card"&gt;');
    });

    it('replaces an in-progress (unclosed) shtml fenced block while streaming', () => {
      const html = renderAssistantMessageContent(
        'Here you go:\n\n```shtml\n<div class="card">Hi',
        true
      );

      expect(html).toContain('class="msg__dip-pending"');
      expect(html).not.toContain('class="language-shtml"');
    });

    it('keeps the shtml code block intact when not streaming so hydrateDips can find it', () => {
      const html = renderAssistantMessageContent(finishedShtml, false);

      expect(html).toContain('class="language-shtml"');
      expect(html).toContain('&lt;div class="card"&gt;Hi&lt;/div&gt;');
      expect(html).not.toContain('msg__dip-pending');
    });

    it('defaults to non-streaming behavior when isStreaming is omitted', () => {
      const html = renderAssistantMessageContent(finishedShtml);

      expect(html).toContain('class="language-shtml"');
      expect(html).not.toContain('msg__dip-pending');
    });

    it('replaces every shtml block when multiple appear in one message', () => {
      const html = renderAssistantMessageContent(
        '```shtml\n<div>one</div>\n```\n\nand\n\n```shtml\n<div>two</div>\n```',
        true
      );

      const matches = html.match(/msg__dip-pending"/g) ?? [];
      expect(matches.length).toBe(2);
      expect(html).not.toContain('class="language-shtml"');
    });

    it('leaves non-shtml fenced blocks untouched while streaming', () => {
      const html = renderAssistantMessageContent('```js\nconst x = 1;\n```', true);

      expect(html).toContain('class="language-js"');
      expect(html).not.toContain('msg__dip-pending');
    });
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
