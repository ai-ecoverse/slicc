import { describe, it, expect } from 'vitest';
import { parseToolResultContentRaw, parseToolResultContent, adaptTool } from './tool-adapter.js';
import type { ToolDefinition } from './types.js';

describe('parseToolResultContentRaw', () => {
  it('returns plain text as a single TextContent block', () => {
    const blocks = parseToolResultContentRaw('Hello world');
    expect(blocks).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('extracts a single img tag into an ImageContent block', () => {
    const text = 'Screenshot saved to /tmp/s.png (500 KB)\n<img:data:image/png;base64,abc123>';
    const blocks = parseToolResultContentRaw(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Screenshot saved to /tmp/s.png (500 KB)' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'abc123' });
  });

  it('extracts JPEG images', () => {
    const text = 'Showing image\n<img:data:image/jpeg;base64,/9j/4AAQ>';
    const blocks = parseToolResultContentRaw(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' });
  });

  it('handles multiple img tags', () => {
    const text = 'Before\n<img:data:image/png;base64,aaa>\nMiddle\n<img:data:image/png;base64,bbb>\nAfter';
    const blocks = parseToolResultContentRaw(text);

    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Before' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aaa' });
    expect(blocks[2]).toEqual({ type: 'text', text: '\nMiddle' });
    expect(blocks[3]).toEqual({ type: 'image', mimeType: 'image/png', data: 'bbb' });
    expect(blocks[4]).toEqual({ type: 'text', text: '\nAfter' });
  });

  it('handles img tag at the start of text', () => {
    const text = '<img:data:image/png;base64,xyz>Some text after';
    const blocks = parseToolResultContentRaw(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'xyz' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'Some text after' });
  });

  it('handles img tag as the entire text', () => {
    const text = '<img:data:image/png;base64,onlyimage>';
    const blocks = parseToolResultContentRaw(text);

    // Should have the image and an empty text block won't be added since blocks.length > 0
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'onlyimage' });
  });

  it('returns empty string as text when input is empty', () => {
    const blocks = parseToolResultContentRaw('');
    expect(blocks).toEqual([{ type: 'text', text: '' }]);
  });

  it('preserves text with no img tags unchanged', () => {
    const text = 'exit code: 0\nsome output\nmore output';
    const blocks = parseToolResultContentRaw(text);
    expect(blocks).toEqual([{ type: 'text', text }]);
  });

  it('filters whitespace-only text between consecutive img tags', () => {
    const text = '<img:data:image/png;base64,aaa>\n\n\n<img:data:image/png;base64,bbb>';
    const blocks = parseToolResultContentRaw(text);
    // Whitespace-only text between images should be filtered (before.trim() check)
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aaa' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'bbb' });
  });

  it('parses open --view output correctly (integration)', () => {
    // Simulates the output of: open --view /workspace/screenshot.png
    const text = '/workspace/screenshot.png (500 KB)\n<img:data:image/png;base64,iVBORw0KGgo>';
    const blocks = parseToolResultContentRaw(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: '/workspace/screenshot.png (500 KB)' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo' });
  });
});

describe('parseToolResultContent (async)', () => {
  it('returns plain text unchanged', async () => {
    const blocks = await parseToolResultContent('Hello world');
    expect(blocks).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('passes through small valid images', async () => {
    const text = 'Screenshot\n<img:data:image/png;base64,abc123>';
    const blocks = await parseToolResultContent(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Screenshot' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'abc123' });
  });

  it('replaces unsupported image format with text placeholder', async () => {
    const text = '<img:data:image/bmp;base64,abc123>';
    const blocks = await parseToolResultContent(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as any).text).toContain('unsupported format');
  });

  it('returns a promise', () => {
    const result = parseToolResultContent('test');
    expect(result).toBeInstanceOf(Promise);
  });
});

describe('adaptTool', () => {
  it('passes through tool results at full size (no truncation)', async () => {
    const hugeContent = 'x'.repeat(100000);
    const mockTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ content: hugeContent, isError: false }),
    };

    const adapted = adaptTool(mockTool);
    const result = await adapted.execute('call-1', {});

    const textBlock = (result.content as any[]).find((c: any) => c.type === 'text');
    expect(textBlock.text).toBe(hugeContent);
  });

  it('preserves isError flag', async () => {
    const mockTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ content: 'error output', isError: true }),
    };

    const adapted = adaptTool(mockTool);
    const result = await adapted.execute('call-1', {});

    expect(result.details).toEqual({ isError: true });
  });

  it('parses image tags into ImageContent blocks', async () => {
    const content = 'Screenshot saved\n<img:data:image/png;base64,abc123>';
    const mockTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ content, isError: false }),
    };

    const adapted = adaptTool(mockTool);
    const result = await adapted.execute('call-1', {});

    const blocks = result.content as any[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Screenshot saved' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'abc123' });
  });

  it('preserves large image blocks at full size (under 5MB)', async () => {
    const largeBase64 = 'A'.repeat(200000);
    const content = `Screenshot saved\n<img:data:image/png;base64,${largeBase64}>`;
    const mockTool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ content, isError: false }),
    };

    const adapted = adaptTool(mockTool);
    const result = await adapted.execute('call-1', {});

    const blocks = result.content as any[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Screenshot saved' });
    expect(blocks[1].type).toBe('image');
    expect(blocks[1].data).toBe(largeBase64);
    expect(blocks[1].data.length).toBe(200000);
  });
});
