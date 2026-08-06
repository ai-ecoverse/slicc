import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_FS_DB_NAME } from '../../../src/fs/global-db.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { readServersFile, testOnlyResetStoreCache } from '../../../src/shell/mcp/store.js';
import {
  PLUGINS_STORE_PATH,
  readPluginsFile,
  testOnlyResetPluginsStoreCache,
} from '../../../src/shell/plugins/store.js';
import {
  PLUGIN_MANIFEST_SCHEMA_ID,
  PLUGIN_MCP_SCHEMA_ID,
} from '../../../src/shell/plugins/types.js';
import { createPluginCommand } from '../../../src/shell/supplemental-commands/plugin-command.js';
import { discoverSkills } from '../../../src/skills/discover.js';

const ROOT = '/workspace/reports-plugin';

let fs: VirtualFS;

const runCmd = async (
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const cmd = createPluginCommand({ fs });
  return cmd.execute(args, { cwd: '/workspace' } as never);
};

async function writeFixturePlugin(options: { mcp?: boolean } = {}): Promise<void> {
  await fs.mkdir(`${ROOT}/skills/summarize`, { recursive: true });
  await fs.writeFile(
    `${ROOT}/plugin.json`,
    JSON.stringify({
      $schema: PLUGIN_MANIFEST_SCHEMA_ID,
      name: 'reports-plugin',
      version: '1.2.0',
      description: 'Report tooling',
    })
  );
  await fs.writeFile(
    `${ROOT}/skills/summarize/SKILL.md`,
    '---\nname: summarize\ndescription: Summarize reports\n---\n# Summarize\n'
  );
  if (options.mcp) {
    await fs.writeFile(
      `${ROOT}/mcp.json`,
      JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: {
          api: { type: 'streamable-http', url: 'https://api.example.com/mcp' },
          local: { type: 'stdio', command: './bin/server' },
        },
      })
    );
  }
}

describe('plugin command', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    testOnlyResetStoreCache();
    testOnlyResetPluginsStoreCache();
    fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME, wipe: true });
  });

  it('shows help with no args and rejects unknown subcommands', async () => {
    const help = await runCmd([]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('usage: plugin <command>');

    const bogus = await runCmd(['bogus']);
    expect(bogus.exitCode).toBe(1);
    expect(bogus.stderr).toContain('unknown subcommand');
  });

  it('install: registers a valid plugin and surfaces its skills via discovery', async () => {
    await writeFixturePlugin();
    const r = await runCmd(['install', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Installed agent plugin "reports-plugin" v1.2.0');
    expect(r.stdout).toContain('summarize');

    const file = await readPluginsFile(fs);
    expect(file.plugins['reports-plugin'].root).toBe(ROOT);
    expect(await fs.exists(PLUGINS_STORE_PATH)).toBe(true);

    const skills = await discoverSkills(fs);
    const pluginSkills = skills.filter((s) => s.source === 'plugin');
    expect(pluginSkills.map((s) => s.name)).toEqual(['summarize']);
    expect(pluginSkills[0].description).toBe('Summarize reports');
  });

  it('install: rejects an invalid plugin with diagnostics', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(`${ROOT}/plugin.json`, JSON.stringify({ name: 'reports-plugin' }));
    const r = await runCmd(['install', 'reports-plugin']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('rejected');
    expect(r.stderr).toContain('$schema');
  });

  it('install: bridges streamable-http MCP servers and skips stdio', async () => {
    await writeFixturePlugin({ mcp: true });
    const r = await runCmd(['install', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('reports-plugin:api');
    expect(r.stdout).toContain('1 skipped');

    const servers = await readServersFile(fs);
    expect(servers.servers['reports-plugin:api'].url).toBe('https://api.example.com/mcp');
    expect(servers.servers['reports-plugin:local']).toBeUndefined();
  });

  it('list: empty + populated output', async () => {
    const empty = await runCmd(['list']);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain('No agent plugins installed');

    await writeFixturePlugin();
    await runCmd(['install', 'reports-plugin']);

    const filled = await runCmd(['list']);
    expect(filled.exitCode).toBe(0);
    expect(filled.stdout).toContain('NAME');
    expect(filled.stdout).toContain('reports-plugin');
    expect(filled.stdout).toContain('1.2.0');
  });

  it('info: shows manifest, skills, and MCP servers', async () => {
    await writeFixturePlugin({ mcp: true });
    await runCmd(['install', 'reports-plugin']);

    const r = await runCmd(['info', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('reports-plugin v1.2.0');
    expect(r.stdout).toContain('summarize');
    expect(r.stdout).toContain('https://api.example.com/mcp');
    expect(r.stdout).toContain('skipped');
  });

  it('validate: OK for a valid plugin, REJECTED for an invalid one', async () => {
    await writeFixturePlugin();
    const valid = await runCmd(['validate', 'reports-plugin']);
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout).toContain('plugin validate: OK');

    await fs.writeFile(`${ROOT}/plugin.json`, JSON.stringify({ name: 'Bad--Name' }));
    const invalid = await runCmd(['validate', 'reports-plugin']);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('REJECTED');
  });

  it('remove: unregisters the plugin and its bridged MCP servers', async () => {
    await writeFixturePlugin({ mcp: true });
    await runCmd(['install', 'reports-plugin']);

    const r = await runCmd(['remove', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Removed agent plugin "reports-plugin"');
    expect(r.stdout).toContain('1 removed');

    expect((await readPluginsFile(fs)).plugins['reports-plugin']).toBeUndefined();
    expect((await readServersFile(fs)).servers['reports-plugin:api']).toBeUndefined();
    expect((await discoverSkills(fs)).filter((s) => s.source === 'plugin')).toEqual([]);
  });

  it('remove: errors for unknown plugins', async () => {
    const r = await runCmd(['remove', 'nope']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no installed plugin');
  });
});
