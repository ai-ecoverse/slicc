/**
 * Tests for the message renderer — markdown parsing and syntax highlighting.
 */

import { describe, expect, it } from 'vitest';
import {
  renderAssistantMessageContent,
  renderMessageContent,
  renderToolInput,
} from '../../src/ui/message-renderer.js';

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

  it('strips the hidden reply-language marker so it never reaches the bubble', () => {
    const html = renderAssistantMessageContent('<!--lang:de-->Hallo Welt');

    expect(html).toContain('Hallo Welt');
    expect(html).not.toContain('lang:de');
    expect(html).not.toContain('<!--');
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

describe('markdown media', () => {
  describe('images', () => {
    it('rewrites a rooted VFS path to a /preview URL', () => {
      const html = renderMessageContent('![shot](/shared/clip/frame.png)');
      expect(html).toContain('/preview/shared/clip/frame.png');
      expect(html).toContain('<img');
    });

    it('stamps the media class so the gallery grouper and CSS can find it', () => {
      expect(renderMessageContent('![shot](/shared/a.png)')).toContain('msg__media--image');
    });

    it('keeps the alt text', () => {
      expect(renderMessageContent('![a cat](/shared/cat.png)')).toContain('alt="a cat"');
    });

    it('leaves a remote URL untouched', () => {
      const html = renderMessageContent('![x](https://example.com/a.png)');
      expect(html).toContain('src="https://example.com/a.png"');
      expect(html).not.toContain('/preview/');
    });
  });

  describe('videos', () => {
    it('renders a .mp4 as a video player, not an image', () => {
      const html = renderMessageContent('![cut](/shared/clip/cut.mp4)');
      expect(html).toContain('<video');
      expect(html).not.toContain('<img');
    });

    it('survives sanitization with its controls intact', () => {
      const html = renderMessageContent('![cut](/shared/cut.mp4)');
      expect(html).toContain('controls');
      expect(html).toContain('preload="metadata"');
      expect(html).toContain('playsinline');
    });

    it('points at the /preview URL so the SW serves real bytes', () => {
      expect(renderMessageContent('![cut](/shared/cut.webm)')).toContain(
        '/preview/shared/cut.webm'
      );
    });

    // `alt` is inert on <video>; carrying it over verbatim would silently drop
    // the only description the author wrote.
    it('carries the alt text over as an aria-label, not an alt', () => {
      const html = renderMessageContent('![the cut](/shared/cut.mp4)');
      expect(html).toContain('aria-label="the cut"');
      expect(html).not.toContain('alt=');
    });
  });

  // The gap the review caught: `audio` was in the sanitizer allowlist but no
  // branch emitted it, so `![](x.mp3)` rendered as an <img> that cannot decode
  // — the same silent failure this change removes for images.
  describe('audio', () => {
    it('renders an .mp3 as an audio player, not an image', () => {
      const html = renderMessageContent('![voiceover](/shared/vo.mp3)');
      expect(html).toContain('<audio');
      expect(html).not.toContain('<img');
    });

    it('keeps controls and points at the /preview URL', () => {
      const html = renderMessageContent('![vo](/shared/vo.mp3)');
      expect(html).toContain('controls');
      expect(html).toContain('/preview/shared/vo.mp3');
    });

    it('carries the alt text over as an aria-label', () => {
      expect(renderMessageContent('![voiceover](/shared/vo.wav)')).toContain(
        'aria-label="voiceover"'
      );
    });

    it('groups audio into a gallery alongside images', () => {
      const html = renderMessageContent('![a](/shared/a.png) ![b](/shared/b.mp3)');
      expect(html).toContain('msg__media-gallery');
      expect(html).toContain('<audio');
    });
  });

  describe('dip references', () => {
    // hydrateDips() looks for img[src$=".shtml"]; a rewritten src or a
    // <video> would both break the handshake.
    it('leaves a .shtml reference as a bare img with its original src', () => {
      const html = renderMessageContent('![palette](/shared/palette.shtml)');
      expect(html).toContain('src="/shared/palette.shtml"');
      expect(html).not.toContain('/preview/');
      expect(html).not.toContain('msg__media');
    });
  });

  describe('galleries', () => {
    it('groups two images on one line into a pair gallery', () => {
      const html = renderMessageContent('![a](/shared/a.png) ![b](/shared/b.png)');
      expect(html).toContain('msg__media-gallery');
      expect(html).toContain('msg__media-gallery--pair');
    });

    it('groups images written on consecutive lines', () => {
      const html = renderMessageContent('![a](/shared/a.png)\n![b](/shared/b.png)');
      expect(html).toContain('msg__media-gallery');
    });

    it('groups four images as an explicit 2x2 rather than an auto-fit 3 + 1', () => {
      const html = renderMessageContent(
        '![a](/shared/a.png) ![b](/shared/b.png) ![c](/shared/c.png) ![d](/shared/d.png)'
      );
      expect(html).toContain('msg__media-gallery--quad');
      expect(html).not.toContain('--pair');
      expect(html.match(/<img/g)).toHaveLength(4);
    });

    it('leaves three items to auto-fit — no count modifier', () => {
      const html = renderMessageContent(
        '![a](/shared/a.png) ![b](/shared/b.png) ![c](/shared/c.png)'
      );
      expect(html).toContain('msg__media-gallery"');
      expect(html).not.toContain('--pair');
      expect(html).not.toContain('--quad');
    });

    it('mixes images and video in one gallery', () => {
      const html = renderMessageContent('![a](/shared/a.png) ![b](/shared/b.mp4)');
      expect(html).toContain('msg__media-gallery');
      expect(html).toContain('<video');
      expect(html).toContain('<img');
    });

    it('leaves a lone image as a normal paragraph', () => {
      const html = renderMessageContent('![a](/shared/a.png)');
      expect(html).not.toContain('msg__media-gallery');
    });

    // A caption is content; grouping would silently drop it.
    it('does not group when the paragraph also carries text', () => {
      const html = renderMessageContent('before ![a](/shared/a.png) ![b](/shared/b.png) after');
      expect(html).not.toContain('msg__media-gallery');
      expect(html).toContain('before');
      expect(html).toContain('after');
    });

    it('does not group images across separate paragraphs', () => {
      const html = renderMessageContent('![a](/shared/a.png)\n\n![b](/shared/b.png)');
      expect(html).not.toContain('msg__media-gallery');
    });
  });

  // Markdown and raw HTML must agree: an agent that reaches for raw HTML to
  // get a layout markdown cannot express should not silently lose its media.
  describe('raw HTML media', () => {
    it('resolves a rooted src on a raw <img>', () => {
      expect(renderMessageContent('<img src="/shared/a.png">')).toContain('/preview/shared/a.png');
    });

    it('resolves a rooted src on a raw <video>', () => {
      const html = renderMessageContent('<video src="/shared/a.mp4" controls></video>');
      expect(html).toContain('/preview/shared/a.mp4');
      expect(html).toContain('<video');
    });

    it('resolves media nested in a raw table', () => {
      const html = renderMessageContent(
        '<table><tr><td><img src="/shared/a.png"></td></tr></table>'
      );
      expect(html).toContain('/preview/shared/a.png');
    });

    it('leaves a raw .shtml dip reference verbatim', () => {
      expect(renderMessageContent('<img src="/shared/p.shtml">')).toContain(
        'src="/shared/p.shtml"'
      );
    });

    it('leaves a remote src alone', () => {
      expect(renderMessageContent('<img src="https://e.com/a.png">')).toContain(
        'src="https://e.com/a.png"'
      );
    });

    it('does not double-resolve markdown-emitted media', () => {
      const html = renderMessageContent('![a](/shared/a.png)');
      expect(html.match(/\/preview\//g)).toHaveLength(1);
    });
  });

  describe('sanitization', () => {
    it('strips a javascript: image href instead of rewriting it', () => {
      const html = renderMessageContent('![x](javascript:alert(1))');
      expect(html).not.toContain('javascript:alert');
    });

    it('drops an onerror handler from raw video HTML', () => {
      const html = renderMessageContent('<video src="/x.mp4" onerror="alert(1)"></video>');
      expect(html).not.toContain('onerror');
    });
  });
});
