import { describe, it, expect } from 'vitest';
import { parseToolResultContent } from './tool-adapter.js';

describe('parseToolResultContent', () => {
  it('returns plain text as a single TextContent block', () => {
    const blocks = parseToolResultContent('Hello world');
    expect(blocks).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('extracts a single img tag into an ImageContent block', () => {
    const text = 'Screenshot saved to /tmp/s.png (500 KB)\n<img:data:image/png;base64,abc123>';
    const blocks = parseToolResultContent(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Screenshot saved to /tmp/s.png (500 KB)' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'abc123' });
  });

  it('extracts JPEG images', () => {
    const text = 'Showing image\n<img:data:image/jpeg;base64,/9j/4AAQ>';
    const blocks = parseToolResultContent(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' });
  });

  it('handles multiple img tags', () => {
    const text = 'Before\n<img:data:image/png;base64,aaa>\nMiddle\n<img:data:image/png;base64,bbb>\nAfter';
    const blocks = parseToolResultContent(text);

    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Before' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aaa' });
    expect(blocks[2]).toEqual({ type: 'text', text: '\nMiddle' });
    expect(blocks[3]).toEqual({ type: 'image', mimeType: 'image/png', data: 'bbb' });
    expect(blocks[4]).toEqual({ type: 'text', text: '\nAfter' });
  });

  it('handles img tag at the start of text', () => {
    const text = '<img:data:image/png;base64,xyz>Some text after';
    const blocks = parseToolResultContent(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'xyz' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'Some text after' });
  });

  it('handles img tag as the entire text', () => {
    const text = '<img:data:image/png;base64,onlyimage>';
    const blocks = parseToolResultContent(text);

    // Should have the image and an empty text block won't be added since blocks.length > 0
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'onlyimage' });
  });

  it('returns empty string as text when input is empty', () => {
    const blocks = parseToolResultContent('');
    expect(blocks).toEqual([{ type: 'text', text: '' }]);
  });

  it('preserves text with no img tags unchanged', () => {
    const text = 'exit code: 0\nsome output\nmore output';
    const blocks = parseToolResultContent(text);
    expect(blocks).toEqual([{ type: 'text', text }]);
  });

  it('filters whitespace-only text between consecutive img tags', () => {
    const text = '<img:data:image/png;base64,aaa>\n\n\n<img:data:image/png;base64,bbb>';
    const blocks = parseToolResultContent(text);
    // Whitespace-only text between images should be filtered (before.trim() check)
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aaa' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'bbb' });
  });

  it('parses open --view output correctly (integration)', () => {
    // Simulates the output of: open --view /workspace/screenshot.png
    const text = '/workspace/screenshot.png (500 KB)\n<img:data:image/png;base64,iVBORw0KGgo>';
    const blocks = parseToolResultContent(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: '/workspace/screenshot.png (500 KB)' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo' });
  });
});
