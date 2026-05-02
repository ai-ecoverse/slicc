import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { resolveSprinkleIconHtml, lucideIconHtml } from '../../src/ui/sprinkle-icon.js';

describe('lucideIconHtml', () => {
  it('returns SVG markup for a known kebab-case name', () => {
    const html = lucideIconHtml('music');
    expect(html).not.toBeNull();
    expect(html!).toContain('<svg');
    expect(html!).toContain('viewBox="0 0 24 24"');
    expect(html!).toContain('stroke="currentColor"');
  });

  it('handles multi-segment names like calendar-clock', () => {
    const html = lucideIconHtml('calendar-clock');
    expect(html).not.toBeNull();
    expect(html!).toContain('<svg');
  });

  it('returns null for unknown icon names', () => {
    expect(lucideIconHtml('not-a-real-icon-xyz')).toBeNull();
  });
});

describe('resolveSprinkleIconHtml', () => {
  let vfs: VirtualFS;
  let dbCounter = 300;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-icon-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns null for an undefined spec', async () => {
    expect(await resolveSprinkleIconHtml(undefined, vfs)).toBeNull();
  });

  it('resolves a Lucide icon name to inline SVG', async () => {
    const html = await resolveSprinkleIconHtml('terminal', vfs);
    expect(html).not.toBeNull();
    expect(html!.startsWith('<svg')).toBe(true);
  });

  it('passes inline SVG through unchanged', async () => {
    const inline = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
    expect(await resolveSprinkleIconHtml(inline, vfs)).toBe(inline);
  });

  it('wraps a data: URL in an <img>', async () => {
    const dataUrl = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';
    const html = await resolveSprinkleIconHtml(dataUrl, vfs);
    expect(html).not.toBeNull();
    expect(html!.startsWith('<img')).toBe(true);
    expect(html!).toContain('width="16"');
    expect(html!).toContain(dataUrl.replace(/"/g, '&quot;'));
  });

  it('reads an SVG file from the VFS and inlines it', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    await vfs.writeFile('/shared/icons/foo.svg', svg);
    const html = await resolveSprinkleIconHtml('/shared/icons/foo.svg', vfs);
    expect(html).toBe(svg);
  });

  it('returns null for an unknown Lucide name', async () => {
    expect(await resolveSprinkleIconHtml('definitely-not-an-icon', vfs)).toBeNull();
  });

  it('returns null when a VFS path does not exist', async () => {
    expect(await resolveSprinkleIconHtml('/missing/icon.svg', vfs)).toBeNull();
  });
});
