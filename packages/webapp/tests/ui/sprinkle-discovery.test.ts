import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  discoverSprinkles,
  extractTitle,
  extractAutoOpen,
  extractIcon,
} from '../../src/ui/sprinkle-discovery.js';

describe('discoverSprinkles', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-discovery-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns empty map when no .shtml files exist', async () => {
    const result = await discoverSprinkles(vfs);
    expect(result.size).toBe(0);
  });

  it('discovers a single .shtml file', async () => {
    await vfs.writeFile('/shared/sprinkles/dashboard/dashboard.shtml', '<div>hello</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.has('dashboard')).toBe(true);
    expect(result.get('dashboard')!.path).toBe('/shared/sprinkles/dashboard/dashboard.shtml');
  });

  it('discovers multiple .shtml files', async () => {
    await vfs.writeFile('/shared/sprinkles/stats/stats.shtml', '<div>stats</div>');
    await vfs.writeFile('/shared/sprinkles/logs/logs.shtml', '<div>logs</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.has('stats')).toBe(true);
    expect(result.has('logs')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('sprinkles directory takes priority over other locations', async () => {
    await vfs.writeFile('/shared/sprinkles/panel/panel.shtml', '<div>sprinkles</div>');
    await vfs.writeFile('/other/panel.shtml', '<div>other</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.get('panel')!.path).toBe('/shared/sprinkles/panel/panel.shtml');
  });

  it('first occurrence wins for duplicate basenames', async () => {
    await vfs.writeFile('/shared/sprinkles/a/dash.shtml', '<div>a</div>');
    await vfs.writeFile('/shared/sprinkles/b/dash.shtml', '<div>b</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.has('dash')).toBe(true);
    expect(result.size >= 1).toBe(true);
  });

  it('extracts title from <title> tag', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/test/test.shtml',
      '<title>My Dashboard</title><div>hello</div>'
    );
    const result = await discoverSprinkles(vfs);
    expect(result.get('test')!.title).toBe('My Dashboard');
  });

  it('extracts title from data-sprinkle-title attribute', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/test/test.shtml',
      '<div data-sprinkle-title="Custom Title">hello</div>'
    );
    const result = await discoverSprinkles(vfs);
    expect(result.get('test')!.title).toBe('Custom Title');
  });

  it('data-sprinkle-title takes priority over <title>', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/test/test.shtml',
      '<title>Title Tag</title><div data-sprinkle-title="Attr Title">hello</div>'
    );
    const result = await discoverSprinkles(vfs);
    expect(result.get('test')!.title).toBe('Attr Title');
  });

  it('falls back to basename when no title found', async () => {
    await vfs.writeFile('/shared/sprinkles/test/test.shtml', '<div>hello</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.get('test')!.title).toBe('test');
  });

  it('ignores non-.shtml files', async () => {
    await vfs.writeFile('/shared/sprinkles/a/readme.md', '# hello');
    await vfs.writeFile('/shared/sprinkles/a/run.jsh', 'echo test');
    await vfs.writeFile('/shared/sprinkles/a/test.shtml', '<div>test</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.size).toBe(1);
    expect(result.has('test')).toBe(true);
  });

  it('discovers .shtml files outside of sprinkles directory', async () => {
    await vfs.writeFile('/tools/monitor.shtml', '<div>monitor</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.get('monitor')!.path).toBe('/tools/monitor.shtml');
  });
});

describe('extractTitle', () => {
  it('extracts from data-sprinkle-title', () => {
    expect(extractTitle('<div data-sprinkle-title="Hello">content</div>', 'fallback')).toBe(
      'Hello'
    );
  });

  it('extracts from <title> tag', () => {
    expect(extractTitle('<title>My Sprinkle</title>', 'fallback')).toBe('My Sprinkle');
  });

  it('prefers data-sprinkle-title over <title>', () => {
    expect(
      extractTitle('<title>Tag</title><div data-sprinkle-title="Attr">x</div>', 'fallback')
    ).toBe('Attr');
  });

  it('returns fallback when no title found', () => {
    expect(extractTitle('<div>no title</div>', 'fallback')).toBe('fallback');
  });

  it('handles empty content', () => {
    expect(extractTitle('', 'fallback')).toBe('fallback');
  });
});

describe('extractAutoOpen', () => {
  it('returns true when data-sprinkle-autoopen is present', () => {
    expect(extractAutoOpen('<div data-sprinkle-autoopen>hello</div>')).toBe(true);
  });

  it('returns true when attribute has a value', () => {
    expect(extractAutoOpen('<div data-sprinkle-autoopen="true">hello</div>')).toBe(true);
  });

  it('returns false when attribute is absent', () => {
    expect(extractAutoOpen('<div data-sprinkle-title="Test">hello</div>')).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(extractAutoOpen('')).toBe(false);
  });
});

describe('extractIcon', () => {
  it('returns href from <link rel="icon"> tag', () => {
    expect(extractIcon('<link rel="icon" href="music" />')).toBe('music');
  });

  it('returns href from <link rel="shortcut icon"> tag', () => {
    expect(extractIcon('<link rel="shortcut icon" href="/icons/foo.svg" />')).toBe(
      '/icons/foo.svg'
    );
  });

  it('handles attribute order rel before href and href before rel', () => {
    expect(extractIcon('<link href="bell" rel="icon" />')).toBe('bell');
    expect(extractIcon('<link rel="icon" href="bell" />')).toBe('bell');
  });

  it('falls back to data-sprinkle-icon attribute', () => {
    expect(extractIcon('<html data-sprinkle-icon="calendar-clock"><body/></html>')).toBe(
      'calendar-clock'
    );
  });

  it('prefers <link rel="icon"> over data-sprinkle-icon', () => {
    expect(
      extractIcon(
        '<html data-sprinkle-icon="calendar"><head><link rel="icon" href="music" /></head></html>'
      )
    ).toBe('music');
  });

  it('returns undefined when neither hint is present', () => {
    expect(extractIcon('<div>no icon here</div>')).toBeUndefined();
  });

  it('handles single-quoted attributes', () => {
    expect(extractIcon("<link rel='icon' href='star' />")).toBe('star');
  });

  it('preserves embedded double quotes inside a single-quoted href', () => {
    const svg =
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>';
    const tag = `<link rel="icon" href='${svg}' />`;
    expect(extractIcon(tag)).toBe(svg);
  });

  it('preserves embedded > characters inside a quoted href value', () => {
    // `>` inside a quoted attribute is legal HTML; a parser that
    // bails at the first `>` would truncate the data URL.
    const svg = "data:image/svg+xml;utf8,<svg viewBox='0 0 1 1'><path d='M0 0'/></svg>";
    const tag = `<link rel="icon" href="${svg}" />`;
    expect(extractIcon(tag)).toBe(svg);
  });

  it('preserves embedded single quotes inside a double-quoted href', () => {
    const svg = "data:image/svg+xml;utf8,<svg viewBox='0 0 24 24'/>";
    const tag = `<link rel="icon" href="${svg}" />`;
    expect(extractIcon(tag)).toBe(svg);
  });
});

describe('discoverSprinkles icon', () => {
  let vfs: VirtualFS;
  let dbCounter = 200;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-icon-discovery-${dbCounter++}`,
      wipe: true,
    });
  });

  it('captures the icon spec from <link rel="icon">', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/strudel-music/strudel-music.shtml',
      '<head><link rel="icon" href="music" /></head><body><div>jam</div></body>'
    );
    const result = await discoverSprinkles(vfs);
    expect(result.get('strudel-music')!.icon).toBe('music');
  });

  it('captures the icon spec from data-sprinkle-icon', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/cal/cal.shtml',
      '<div data-sprinkle-icon="calendar-clock">cal</div>'
    );
    const result = await discoverSprinkles(vfs);
    expect(result.get('cal')!.icon).toBe('calendar-clock');
  });

  it('leaves icon undefined when no spec is present', async () => {
    await vfs.writeFile('/shared/sprinkles/plain/plain.shtml', '<div>plain</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.get('plain')!.icon).toBeUndefined();
  });
});

describe('discoverSprinkles autoOpen', () => {
  let vfs: VirtualFS;
  let dbCounter = 100;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-sprinkle-autoopen-${dbCounter++}`,
      wipe: true,
    });
  });

  it('sets autoOpen true when data-sprinkle-autoopen is present', async () => {
    await vfs.writeFile(
      '/shared/sprinkles/panel/panel.shtml',
      '<div data-sprinkle-autoopen>hi</div>'
    );
    const result = await discoverSprinkles(vfs);
    expect(result.get('panel')!.autoOpen).toBe(true);
  });

  it('sets autoOpen false when attribute is absent', async () => {
    await vfs.writeFile('/shared/sprinkles/panel/panel.shtml', '<div>hi</div>');
    const result = await discoverSprinkles(vfs);
    expect(result.get('panel')!.autoOpen).toBe(false);
  });
});
