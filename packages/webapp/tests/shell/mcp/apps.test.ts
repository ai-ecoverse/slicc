import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MCP_SPRINKLES_DIR,
  escapeHtml,
  materializeAppSprinkles,
  removeAppSprinkles,
  renderAppSprinkle,
  slugifyAppName,
} from '../../../src/shell/mcp/apps.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { GLOBAL_FS_DB_NAME } from '../../../src/fs/global-db.js';

async function wipeFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME, wipe: true });
}

describe('slugifyAppName', () => {
  it('lowercases and replaces non-alphanumeric runs with hyphens', () => {
    expect(slugifyAppName('Demo App!')).toBe('demo-app');
    expect(slugifyAppName('  Hello  World  ')).toBe('hello-world');
    expect(slugifyAppName('CamelCase')).toBe('camelcase');
    expect(slugifyAppName('a/b/c.d')).toBe('a-b-c-d');
  });

  it('falls back to "app" when nothing usable remains', () => {
    expect(slugifyAppName('!!!')).toBe('app');
    expect(slugifyAppName('')).toBe('app');
  });

  it('caps length at 64', () => {
    const long = 'x'.repeat(200);
    expect(slugifyAppName(long).length).toBe(64);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'
    );
  });
});

describe('renderAppSprinkle', () => {
  it('embeds title, description, templateUri, and bridge wiring', () => {
    const html = renderAppSprinkle('weather', {
      name: 'forecast',
      title: 'Forecast',
      description: 'Daily forecast',
      templateUri: 'https://example.com/forecast.html',
    });
    expect(html).toContain('data-sprinkle-title="Forecast"');
    expect(html).toContain('<h2');
    expect(html).toContain('Forecast');
    expect(html).toContain('Daily forecast');
    expect(html).toContain('src="https://example.com/forecast.html"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('window.mcpInvoke');
    expect(html).toContain('mcp:lick');
    expect(html).toContain('mcp:invoke');
    expect(html).toContain('"weather"');
    expect(html).toContain('"forecast"');
  });

  it('falls back to app.name when title is missing and omits empty description', () => {
    const html = renderAppSprinkle('weather', {
      name: 'forecast',
      templateUri: 'https://example.com/x',
    });
    expect(html).toContain('data-sprinkle-title="forecast"');
    expect(html).not.toContain('<p ');
  });

  it('HTML-escapes title, description, server, and template URI', () => {
    const html = renderAppSprinkle('srv&"<>', {
      name: 'a',
      title: '<script>x</script>',
      description: 'A & B',
      templateUri: 'https://example.com/?q=1&r=2',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('q=1&amp;r=2');
    // Server name is JSON-encoded in the script, so quotes remain JSON-quoted,
    // but raw HTML metacharacters in the value must not break out of the tag.
    expect(html).toContain('"srv&\\"<>"');
  });
});

describe('materializeAppSprinkles / removeAppSprinkles', () => {
  beforeEach(async () => {
    await wipeFs();
  });

  afterEach(async () => {
    // Let LightningFS finish its debounced superblock write.
    await new Promise((r) => setTimeout(r, 600));
  });

  it('writes one .shtml per app with a templateUri', async () => {
    const paths = await materializeAppSprinkles('weather', [
      { name: 'forecast', title: 'Forecast', templateUri: 'https://a.test' },
      { name: 'radar', title: 'Radar', templateUri: 'https://b.test' },
    ]);
    expect(paths.sort()).toEqual([
      `${MCP_SPRINKLES_DIR}/weather/forecast.shtml`,
      `${MCP_SPRINKLES_DIR}/weather/radar.shtml`,
    ]);
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    expect(await fs.exists(`${MCP_SPRINKLES_DIR}/weather/forecast.shtml`)).toBe(true);
    expect(await fs.exists(`${MCP_SPRINKLES_DIR}/weather/radar.shtml`)).toBe(true);
  });

  it('skips apps without a templateUri and returns an empty list when none qualify', async () => {
    const paths = await materializeAppSprinkles('srv', [
      { name: 'no-template-1' },
      { name: 'no-template-2', title: 'X' },
    ]);
    expect(paths).toEqual([]);
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    expect(await fs.exists(`${MCP_SPRINKLES_DIR}/srv`)).toBe(false);
  });

  it('deduplicates colliding slugs with a numeric suffix', async () => {
    const paths = await materializeAppSprinkles('srv', [
      { name: 'Demo App', templateUri: 'https://a.test' },
      { name: 'demo-app', templateUri: 'https://b.test' },
    ]);
    expect(paths).toEqual([
      `${MCP_SPRINKLES_DIR}/srv/demo-app.shtml`,
      `${MCP_SPRINKLES_DIR}/srv/demo-app-2.shtml`,
    ]);
  });

  it('clears stale per-server sprinkles before each materialization', async () => {
    await materializeAppSprinkles('srv', [{ name: 'old-app', templateUri: 'https://a.test' }]);
    await materializeAppSprinkles('srv', [{ name: 'new-app', templateUri: 'https://b.test' }]);
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    expect(await fs.exists(`${MCP_SPRINKLES_DIR}/srv/old-app.shtml`)).toBe(false);
    expect(await fs.exists(`${MCP_SPRINKLES_DIR}/srv/new-app.shtml`)).toBe(true);
  });

  it('removeAppSprinkles wipes the per-server directory', async () => {
    await materializeAppSprinkles('srv', [{ name: 'a', templateUri: 'https://a.test' }]);
    const removed = await removeAppSprinkles('srv');
    expect(removed).toBe(true);
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    expect(await fs.exists(`${MCP_SPRINKLES_DIR}/srv`)).toBe(false);
  });

  it('removeAppSprinkles is a no-op when the directory is missing', async () => {
    const removed = await removeAppSprinkles('ghost');
    expect(removed).toBe(false);
  });
});
