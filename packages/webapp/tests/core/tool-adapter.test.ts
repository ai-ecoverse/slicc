import { describe, it, expect } from 'vitest';
import {
  parseToolResultContentRaw,
  parseToolResultContent,
  adaptTool,
} from '../../src/core/tool-adapter.js';
import type { ToolDefinition } from '../../src/core/types.js';

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
    const text =
      'Before\n<img:data:image/png;base64,aaa>\nMiddle\n<img:data:image/png;base64,bbb>\nAfter';
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

  it('handles mixed valid and unsupported images in one result', async () => {
    const text =
      'Result:\n<img:data:image/bmp;base64,bad>\nMiddle\n<img:data:image/png;base64,good>';
    const blocks = await parseToolResultContent(text);

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Result:' });
    // BMP is unsupported → text placeholder
    expect(blocks[1].type).toBe('text');
    expect((blocks[1] as any).text).toContain('unsupported format');
    expect(blocks[2]).toEqual({ type: 'text', text: '\nMiddle' });
    // PNG is supported → passes through
    expect(blocks[3]).toEqual({ type: 'image', mimeType: 'image/png', data: 'good' });
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

describe('adaptTool — process manager wiring (Phase 3.4)', () => {
  it('registers a kind:"tool" process and exits 0 on clean return', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const mockTool: ToolDefinition = {
      name: 'read_file',
      description: 'read',
      inputSchema: { type: 'object' },
      async execute() {
        return { content: 'ok', isError: false };
      },
    };
    const adapted = adaptTool(mockTool, {
      processManager: pm,
      owner: { kind: 'cone' },
      getParentPid: () => 2000,
    });
    await adapted.execute('call-1', {});
    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].kind).toBe('tool');
    expect(procs[0].argv[0]).toBe('read_file');
    expect(procs[0].ppid).toBe(2000);
    expect(procs[0].exitCode).toBe(0);
    expect(procs[0].status).toBe('exited');
  });

  it('exits 1 when the tool returns isError', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const mockTool: ToolDefinition = {
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      async execute() {
        return { content: 'fail', isError: true };
      },
    };
    const adapted = adaptTool(mockTool, {
      processManager: pm,
      owner: { kind: 'cone' },
    });
    await adapted.execute('call-1', {});
    expect(pm.list()[0].exitCode).toBe(1);
  });

  it('mirrors the agent signal onto the process abort', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    let observedSignal: AbortSignal | undefined;
    const mockTool: ToolDefinition = {
      name: 'sleep-tool',
      description: 'sleep',
      inputSchema: { type: 'object' },
      async execute(_p, signal) {
        observedSignal = signal;
        return { content: 'done', isError: false };
      },
    };
    const adapted = adaptTool(mockTool, {
      processManager: pm,
      owner: { kind: 'cone' },
    });
    const upstream = new AbortController();
    await adapted.execute('call-1', {}, upstream.signal);
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(false);
    expect(pm.list()[0].exitCode).toBe(0);
  });

  it('exits 130 when the upstream signal aborts mid-execute', async () => {
    const { ProcessManager } = await import('../../src/kernel/process-manager.js');
    const pm = new ProcessManager();
    const mockTool: ToolDefinition = {
      name: 'sleep-tool',
      description: 'sleep',
      inputSchema: { type: 'object' },
      async execute(_p, signal) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 1000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        return { content: '', isError: false };
      },
    };
    const adapted = adaptTool(mockTool, {
      processManager: pm,
      owner: { kind: 'cone' },
    });
    const upstream = new AbortController();
    const p = adapted.execute('call-1', {}, upstream.signal);
    setTimeout(() => upstream.abort(), 20);
    await expect(p).rejects.toThrow('aborted');
    const proc = pm.list()[0];
    expect(proc.exitCode).toBe(130);
    expect(proc.status).toBe('killed');
  });

  it('does not register processes when no manager is wired (backwards compatible)', async () => {
    const mockTool: ToolDefinition = {
      name: 'read_file',
      description: 'read',
      inputSchema: { type: 'object' },
      async execute() {
        return { content: 'ok', isError: false };
      },
    };
    const adapted = adaptTool(mockTool);
    const result = await adapted.execute('call-1', {});
    expect(result.details?.isError).toBe(false);
  });

  describe('argv surfaces the tool argument', () => {
    async function runWithParams(
      toolName: string,
      params: Record<string, unknown>
    ): Promise<readonly string[]> {
      const { ProcessManager } = await import('../../src/kernel/process-manager.js');
      const pm = new ProcessManager();
      const tool: ToolDefinition = {
        name: toolName,
        description: '',
        inputSchema: { type: 'object' },
        async execute() {
          return { content: '', isError: false };
        },
      };
      const adapted = adaptTool(tool, {
        processManager: pm,
        owner: { kind: 'cone' },
      });
      await adapted.execute('id', params);
      return pm.list()[0].argv;
    }

    it('appends `command` for the bash tool', async () => {
      const argv = await runWithParams('bash', { command: 'date && sleep 90 && date' });
      expect(argv).toEqual(['bash', 'date && sleep 90 && date']);
    });

    it('appends `path` for read_file', async () => {
      const argv = await runWithParams('read_file', { path: '/workspace/foo.ts' });
      expect(argv).toEqual(['read_file', '/workspace/foo.ts']);
    });

    it('prefers `file_path` over `path` when both exist', async () => {
      const argv = await runWithParams('edit_file', {
        file_path: '/a',
        path: '/b',
      });
      expect(argv).toEqual(['edit_file', '/a']);
    });

    it('falls back to the first non-empty string param when no preferred field matches', async () => {
      const argv = await runWithParams('exotic', {
        flag: true,
        count: 7,
        whatever: 'pick-me',
      });
      expect(argv).toEqual(['exotic', 'pick-me']);
    });

    it('returns just the tool name when no string params are present', async () => {
      const argv = await runWithParams('zero', { count: 7 });
      expect(argv).toEqual(['zero']);
    });

    it('returns just the tool name when params is null / undefined', async () => {
      const { ProcessManager } = await import('../../src/kernel/process-manager.js');
      const pm = new ProcessManager();
      const tool: ToolDefinition = {
        name: 'noargs',
        description: '',
        inputSchema: { type: 'object' },
        async execute() {
          return { content: '', isError: false };
        },
      };
      const adapted = adaptTool(tool, { processManager: pm, owner: { kind: 'cone' } });
      await adapted.execute('id', null);
      expect(pm.list()[0].argv).toEqual(['noargs']);
    });
  });
});
