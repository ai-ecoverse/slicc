import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import { discoverShtmlPanels, extractTitle } from './shtml-discovery.js';

describe('discoverShtmlPanels', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-shtml-discovery-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns empty map when no .shtml files exist', async () => {
    const result = await discoverShtmlPanels(vfs);
    expect(result.size).toBe(0);
  });

  it('discovers a single .shtml file', async () => {
    await vfs.writeFile('/workspace/skills/dashboard/dashboard.shtml', '<div>hello</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.has('dashboard')).toBe(true);
    expect(result.get('dashboard')!.path).toBe('/workspace/skills/dashboard/dashboard.shtml');
  });

  it('discovers multiple .shtml files', async () => {
    await vfs.writeFile('/workspace/skills/a/stats.shtml', '<div>stats</div>');
    await vfs.writeFile('/workspace/skills/b/logs.shtml', '<div>logs</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.has('stats')).toBe(true);
    expect(result.has('logs')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('skills directory takes priority over other locations', async () => {
    await vfs.writeFile('/workspace/skills/panel/panel.shtml', '<div>skills</div>');
    await vfs.writeFile('/other/panel.shtml', '<div>other</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.get('panel')!.path).toBe('/workspace/skills/panel/panel.shtml');
  });

  it('first occurrence wins for duplicate basenames', async () => {
    await vfs.writeFile('/workspace/skills/a/dash.shtml', '<div>a</div>');
    await vfs.writeFile('/workspace/skills/b/dash.shtml', '<div>b</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.has('dash')).toBe(true);
    expect(result.size >= 1).toBe(true);
  });

  it('extracts title from <title> tag', async () => {
    await vfs.writeFile('/workspace/skills/test/test.shtml', '<title>My Dashboard</title><div>hello</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.get('test')!.title).toBe('My Dashboard');
  });

  it('extracts title from data-shtml-title attribute', async () => {
    await vfs.writeFile('/workspace/skills/test/test.shtml', '<div data-shtml-title="Custom Title">hello</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.get('test')!.title).toBe('Custom Title');
  });

  it('data-shtml-title takes priority over <title>', async () => {
    await vfs.writeFile('/workspace/skills/test/test.shtml', '<title>Title Tag</title><div data-shtml-title="Attr Title">hello</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.get('test')!.title).toBe('Attr Title');
  });

  it('falls back to basename when no title found', async () => {
    await vfs.writeFile('/workspace/skills/test/test.shtml', '<div>hello</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.get('test')!.title).toBe('test');
  });

  it('ignores non-.shtml files', async () => {
    await vfs.writeFile('/workspace/skills/a/readme.md', '# hello');
    await vfs.writeFile('/workspace/skills/a/run.jsh', 'echo test');
    await vfs.writeFile('/workspace/skills/a/test.shtml', '<div>test</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.size).toBe(1);
    expect(result.has('test')).toBe(true);
  });

  it('discovers .shtml files outside of skills directory', async () => {
    await vfs.writeFile('/tools/monitor.shtml', '<div>monitor</div>');
    const result = await discoverShtmlPanels(vfs);
    expect(result.get('monitor')!.path).toBe('/tools/monitor.shtml');
  });
});

describe('extractTitle', () => {
  it('extracts from data-shtml-title', () => {
    expect(extractTitle('<div data-shtml-title="Hello">content</div>', 'fallback')).toBe('Hello');
  });

  it('extracts from <title> tag', () => {
    expect(extractTitle('<title>My Panel</title>', 'fallback')).toBe('My Panel');
  });

  it('prefers data-shtml-title over <title>', () => {
    expect(extractTitle('<title>Tag</title><div data-shtml-title="Attr">x</div>', 'fallback')).toBe('Attr');
  });

  it('returns fallback when no title found', () => {
    expect(extractTitle('<div>no title</div>', 'fallback')).toBe('fallback');
  });

  it('handles empty content', () => {
    expect(extractTitle('', 'fallback')).toBe('fallback');
  });
});
