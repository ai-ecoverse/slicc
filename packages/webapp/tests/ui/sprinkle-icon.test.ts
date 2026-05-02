import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { resolveSprinkleIconHtml, lucideIconHtml } from '../../src/ui/sprinkle-icon.js';

describe('lucideIconHtml', () => {
  it('returns SVG markup for a known kebab-case name', async () => {
    const html = await lucideIconHtml('music');
    expect(html).not.toBeNull();
    expect(html!).toContain('<svg');
    expect(html!).toContain('viewBox="0 0 24 24"');
    expect(html!).toContain('stroke="currentColor"');
  });

  it('handles multi-segment names like calendar-clock', async () => {
    const html = await lucideIconHtml('calendar-clock');
    expect(html).not.toBeNull();
    expect(html!).toContain('<svg');
  });

  it('returns null for unknown icon names', async () => {
    expect(await lucideIconHtml('not-a-real-icon-xyz')).toBeNull();
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

  it('wraps inline SVG as a base64 data-url <img> (script-disabled context)', async () => {
    const inline = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
    const html = await resolveSprinkleIconHtml(inline, vfs);
    expect(html).not.toBeNull();
    expect(html!.startsWith('<img')).toBe(true);
    expect(html!).toContain('src="data:image/svg+xml;base64,');
    // The raw SVG must NOT be inlined verbatim — that would let
    // <svg onload=...>, <script>, and <foreignObject> escape into
    // the parent UI's DOM.
    expect(html!).not.toContain('<circle');
  });

  it('does not allow event-handler escapes from a malicious inline SVG', async () => {
    const malicious = '<svg onload="alert(1)"><script>alert(2)</script></svg>';
    const html = await resolveSprinkleIconHtml(malicious, vfs);
    expect(html).not.toBeNull();
    expect(html!).not.toContain('onload=');
    expect(html!).not.toContain('<script');
    expect(html!.startsWith('<img')).toBe(true);
  });

  it('wraps a data: URL in an <img>', async () => {
    const dataUrl = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';
    const html = await resolveSprinkleIconHtml(dataUrl, vfs);
    expect(html).not.toBeNull();
    expect(html!.startsWith('<img')).toBe(true);
    expect(html!).toContain('width="16"');
    // Verify proper attribute escaping: <, >, &, " all encoded.
    expect(html!).toContain('&lt;svg');
    expect(html!).toContain('xmlns=&quot;');
  });

  it('escapes & in the src attribute so entity payloads cannot break out', async () => {
    const dataUrl = 'data:image/svg+xml;utf8,<svg/>?x=&quot;onerror=&quot;';
    const html = await resolveSprinkleIconHtml(dataUrl, vfs);
    expect(html).not.toBeNull();
    // & must be escaped as &amp; — otherwise &quot; entities in the
    // payload would close the src attribute and inject new ones.
    expect(html!).toContain('&amp;quot;');
    expect(html!).not.toMatch(/src="[^"]*&quot;[^"]*"/);
  });

  it('reads an SVG file from the VFS and renders it via <img> (no innerHTML escape)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    await vfs.writeFile('/shared/icons/foo.svg', svg);
    const html = await resolveSprinkleIconHtml('/shared/icons/foo.svg', vfs);
    expect(html).not.toBeNull();
    expect(html!.startsWith('<img')).toBe(true);
    expect(html!).toContain('src="data:image/svg+xml;base64,');
    expect(html!).not.toContain('<path');
  });

  it('returns null for an unknown Lucide name', async () => {
    expect(await resolveSprinkleIconHtml('definitely-not-an-icon', vfs)).toBeNull();
  });

  it('returns null when a VFS path does not exist', async () => {
    expect(await resolveSprinkleIconHtml('/missing/icon.svg', vfs)).toBeNull();
  });
});
