import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { isValidPluginName, loadPluginFromDirectory } from '../../../src/shell/plugins/loader.js';
import {
  PLUGIN_MANIFEST_SCHEMA_ID,
  PLUGIN_MCP_SCHEMA_ID,
} from '../../../src/shell/plugins/types.js';

const ROOT = '/workspace/my-plugin';

async function writePlugin(
  fs: VirtualFS,
  manifest: unknown,
  extras: Record<string, string> = {}
): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(`${ROOT}/plugin.json`, JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(extras)) {
    const path = `${ROOT}/${rel}`;
    const dir = path.replace(/\/[^/]+$/, '');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, content);
  }
}

const minimalManifest = { $schema: PLUGIN_MANIFEST_SCHEMA_ID, name: 'my-plugin' };

describe('isValidPluginName (§5.5)', () => {
  it('accepts spec-valid names', () => {
    for (const name of ['my-plugin', 'acme.tools', 'lint3r', 'a']) {
      expect(isValidPluginName(name), name).toBe(true);
    }
  });

  it('rejects spec-invalid names', () => {
    for (const name of [
      'My-Plugin',
      '-start',
      'end-',
      'has--double',
      'too.many..dots',
      '',
      '.a',
      'a'.repeat(65),
    ]) {
      expect(isValidPluginName(name), name || '(empty)').toBe(false);
    }
  });
});

describe('loadPluginFromDirectory', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    fs = await VirtualFS.create({ wipe: true });
  });

  it('loads a minimal manifest-only plugin', async () => {
    await writePlugin(fs, minimalManifest);
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.manifest.name).toBe('my-plugin');
    expect(result.plugin.skills).toEqual([]);
    expect(result.plugin.mcp.status).toBe('absent');
  });

  it('rejects a plugin with no plugin.json', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].message).toContain('missing plugin.json');
  });

  it('rejects invalid JSON, missing $schema, unsupported version, and bad names', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(`${ROOT}/plugin.json`, '{nope');
    expect((await loadPluginFromDirectory(fs, ROOT)).ok).toBe(false);

    await writePlugin(fs, { name: 'my-plugin' });
    expect((await loadPluginFromDirectory(fs, ROOT)).ok).toBe(false);

    await writePlugin(fs, {
      $schema: 'https://agent-plugins.org/schemas/9.0.0/plugin.schema.json',
      name: 'my-plugin',
    });
    expect((await loadPluginFromDirectory(fs, ROOT)).ok).toBe(false);

    await writePlugin(fs, { $schema: PLUGIN_MANIFEST_SCHEMA_ID, name: 'Bad--Name' });
    expect((await loadPluginFromDirectory(fs, ROOT)).ok).toBe(false);
  });

  it('reports and ignores unknown top-level fields (§5.2 non-fatal)', async () => {
    await writePlugin(fs, { ...minimalManifest, banana: true });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes('banana'))).toBe(true);
  });

  it('reports and ignores a non-object extensions field (§8.1 non-fatal)', async () => {
    await writePlugin(fs, { ...minimalManifest, extensions: 'nope' });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.manifest.extensions).toBeUndefined();
    expect(result.diagnostics.some((d) => d.message.includes('extensions'))).toBe(true);
  });

  it('preserves unimplemented extensions namespaces without validating contents', async () => {
    await writePlugin(fs, {
      ...minimalManifest,
      extensions: { 'com.example.client': { anything: [1, 2, 3] } },
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.manifest.extensions).toEqual({
      'com.example.client': { anything: [1, 2, 3] },
    });
  });

  it('rejects wrong-typed metadata fields (fatal §5.2)', async () => {
    await writePlugin(fs, { ...minimalManifest, keywords: 'not-an-array' });
    expect((await loadPluginFromDirectory(fs, ROOT)).ok).toBe(false);

    await writePlugin(fs, { ...minimalManifest, author: { name: 'x', rank: 'colonel' } });
    expect((await loadPluginFromDirectory(fs, ROOT)).ok).toBe(false);
  });

  it('discovers skills from skills/*/SKILL.md, immediate children only (§7.1)', async () => {
    await writePlugin(fs, minimalManifest, {
      'skills/summarize/SKILL.md': '---\nname: summarize\ndescription: Summarize docs\n---\nBody',
      'skills/deep/nested/SKILL.md': '---\nname: nested\ndescription: too deep\n---\n',
      'skills/no-frontmatter/SKILL.md': 'no frontmatter here',
      'skills/loose-file.md': 'not a skill dir',
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.skills.map((s) => s.name)).toEqual(['summarize']);
    expect(result.plugin.skills[0].description).toBe('Summarize docs');
    // the invalid skill is reported, not fatal
    expect(result.diagnostics.some((d) => d.message.includes('no-frontmatter'))).toBe(true);
  });

  it('loads mcp.json, keeping streamable-http and skipping stdio/sse (§7.2)', async () => {
    await writePlugin(fs, minimalManifest, {
      'mcp.json': JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: {
          remote: { type: 'streamable-http', url: 'https://deploy.example.com/mcp' },
          local: { type: 'stdio', command: './bin/server' },
          legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
        },
      }),
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.plugin.mcp.servers.map((s) => [s.name, s.status]));
    expect(byName).toEqual({
      remote: 'supported',
      local: 'unsupported-transport',
      legacy: 'unsupported-transport',
    });
  });

  it('marks invalid server entries without breaking others (§7.2.2)', async () => {
    await writePlugin(fs, minimalManifest, {
      'mcp.json': JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: {
          good: { type: 'streamable-http', url: 'https://ok.example.com/mcp' },
          'bad-transport': { type: 'websocket', url: 'wss://x' },
          'bad-url': { type: 'streamable-http', url: 'http://not-loopback.example.com/mcp' },
          'bad-field': { type: 'streamable-http', url: 'https://ok.example.com', command: 'x' },
          'bad-headers': {
            type: 'streamable-http',
            url: 'https://ok.example.com',
            headers: { 'X-A': 'v', 'x-a': 'v2' },
          },
        },
      }),
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.plugin.mcp.servers.map((s) => [s.name, s.status]));
    expect(byName.good).toBe('supported');
    expect(byName['bad-transport']).toBe('invalid');
    expect(byName['bad-url']).toBe('invalid');
    expect(byName['bad-field']).toBe('invalid');
    expect(byName['bad-headers']).toBe('invalid');
  });

  it('allows http for loopback hosts', async () => {
    await writePlugin(fs, minimalManifest, {
      'mcp.json': JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: {
          local: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
          ip: { type: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' },
        },
      }),
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.mcp.servers.every((s) => s.status === 'supported')).toBe(true);
  });

  it('disables MCP as a whole for schema-level violations, skills still load (§7.2.2 rule 2)', async () => {
    await writePlugin(fs, minimalManifest, {
      'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy things\n---\n',
      'mcp.json': JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: {},
        rogue: true,
      }),
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.mcp.status).toBe('invalid');
    expect(result.plugin.skills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('disables MCP on a version mismatch with plugin.json (§10.1)', async () => {
    await writePlugin(fs, minimalManifest, {
      'mcp.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
        mcpServers: {},
      }),
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.mcp.status).toBe('invalid');
  });

  it('accepts an empty mcpServers object as valid', async () => {
    await writePlugin(fs, minimalManifest, {
      'mcp.json': JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA_ID, mcpServers: {} }),
    });
    const result = await loadPluginFromDirectory(fs, ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.mcp.status).toBe('loaded');
    expect(result.plugin.mcp.servers).toEqual([]);
  });
});
