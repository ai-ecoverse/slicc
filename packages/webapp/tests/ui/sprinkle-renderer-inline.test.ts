import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inlineExternalScripts } from '../../src/ui/sprinkle-renderer.js';

describe('inlineExternalScripts', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns HTML unchanged when no external scripts', async () => {
    const html = '<html><body><script>console.log("hi")</script></body></html>';
    const result = await inlineExternalScripts(html);
    expect(result).toBe(html);
  });

  it('inlines a single external https script', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('var x = 1;'),
    });
    const html = '<script src="https://cdn.example.com/lib.js"></script>';
    const result = await inlineExternalScripts(html);
    expect(result).toContain('<script>var x = 1;</script>');
    expect(result).not.toContain('src=');
  });

  it('preserves script order with multiple externals', async () => {
    let callOrder = 0;
    (global.fetch as any).mockImplementation((url: string) => {
      const order = ++callOrder;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(`/* script ${order}: ${url} */`),
      });
    });
    const html =
      '<script src="https://a.com/a.js"></script>' +
      '<script>inline</script>' +
      '<script src="https://b.com/b.js"></script>';
    const result = await inlineExternalScripts(html);
    const aPos = result.indexOf('script 1');
    const bPos = result.indexOf('script 2');
    expect(aPos).toBeLessThan(bPos);
    expect(result).toContain('<script>inline</script>');
  });

  it('handles fetch failure with console.error', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));
    const html = '<script src="https://cdn.example.com/fail.js"></script>';
    const result = await inlineExternalScripts(html);
    expect(result).toContain('console.error');
    expect(result).toContain('Network error');
  });

  it('skips relative and non-http src', async () => {
    const html =
      '<script src="local.js"></script>' + '<script src="data:text/javascript,alert(1)"></script>';
    const result = await inlineExternalScripts(html);
    expect(result).toBe(html);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('preserves $& replacement patterns in fetched content', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('n.replace(Wt,"\\\\$&")'),
    });
    const html = '<script src="https://cdn.example.com/lib.js"></script>';
    const result = await inlineExternalScripts(html);
    expect(result).toContain('\\\\$&');
    expect(result).not.toContain('cdn.example.com');
  });

  it('escapes closing script tags in fetched content', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('var s = "</script>";'),
    });
    const html = '<script src="https://cdn.example.com/lib.js"></script>';
    const result = await inlineExternalScripts(html);
    expect(result).not.toMatch(/<\/script>";/);
    expect(result).toContain('<\\/script');
  });
});
