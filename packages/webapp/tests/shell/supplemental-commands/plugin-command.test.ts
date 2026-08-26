import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { zipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_FS_DB_NAME } from '../../../src/fs/global-db.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  readServersFile,
  setServer,
  testOnlyResetStoreCache,
} from '../../../src/shell/mcp/store.js';
import {
  PLUGINS_STORE_PATH,
  readPluginsFile,
  testOnlyResetPluginsStoreCache,
} from '../../../src/shell/plugins/store.js';
import {
  PLUGIN_MANIFEST_SCHEMA_ID,
  PLUGIN_MCP_SCHEMA_ID,
} from '../../../src/shell/plugins/types.js';
import {
  createPluginCommand,
  PLUGIN_SOURCES_DIR,
} from '../../../src/shell/supplemental-commands/plugin-command.js';
import { discoverSkills } from '../../../src/skills/discover.js';

const ROOT = '/workspace/reports-plugin';

let fs: VirtualFS;

const runCmd = async (
  args: string[],
  fetchFn?: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const cmd = createPluginCommand({ fs, ...(fetchFn ? { fetch: fetchFn } : {}) });
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

  it('rejects unknown flags instead of silently ignoring them (#2255)', async () => {
    // The pre-fix install path filtered any `--*` token out of positionals
    // and still exited 0 when a path remained — indistinguishable from honouring
    // the flag. list ignored unknowns entirely.
    const install = await runCmd(['install', '--json', 'reports-plugin']);
    expect(install.exitCode).toBe(1);
    expect(install.stderr).toContain('unknown flag: --json');

    const list = await runCmd(['list', '--all']);
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain('unknown flag: --all');

    const info = await runCmd(['info', 'reports-plugin', '--bogus']);
    expect(info.exitCode).toBe(1);
    expect(info.stderr).toContain('unknown flag: --bogus');

    // `--` still lets a dash-prefixed path through as positional.
    await fs.mkdir('/workspace/-dash-plugin', { recursive: true });
    await fs.writeFile(
      '/workspace/-dash-plugin/plugin.json',
      JSON.stringify({
        $schema: PLUGIN_MANIFEST_SCHEMA_ID,
        name: 'dash-plugin',
        version: '1.0.0',
      })
    );
    const viaTerminator = await runCmd(['validate', '--', '-dash-plugin']);
    expect(viaTerminator.exitCode).toBe(0);
    expect(viaTerminator.stdout).toContain('OK');
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

  it('install: reinstall at the same root removes MCP servers dropped from the manifest', async () => {
    await writeFixturePlugin({ mcp: true });
    await runCmd(['install', 'reports-plugin']);
    expect((await readServersFile(fs)).servers['reports-plugin:api']).toBeDefined();

    // The plugin's mcp.json replaces "api" with "api2" between installs.
    await fs.writeFile(
      `${ROOT}/mcp.json`,
      JSON.stringify({
        $schema: PLUGIN_MCP_SCHEMA_ID,
        mcpServers: {
          api2: { type: 'streamable-http', url: 'https://api2.example.com/mcp' },
        },
      })
    );
    const r = await runCmd(['install', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 removed from previous install');

    const servers = await readServersFile(fs);
    expect(servers.servers['reports-plugin:api']).toBeUndefined();
    expect(servers.servers['reports-plugin:api2'].url).toBe('https://api2.example.com/mcp');
    const file = await readPluginsFile(fs);
    expect(file.plugins['reports-plugin'].mcpServerNames).toEqual(['reports-plugin:api2']);
  });

  it('install: refuses to overwrite a user-added MCP server sharing the bridged name', async () => {
    await setServer('reports-plugin:api', { url: 'https://user.example.com/mcp' }, fs);
    await writeFixturePlugin({ mcp: true });

    const r = await runCmd(['install', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('0 registered');
    expect(r.stdout).toContain('not bridged');
    expect(r.stdout).toContain('reports-plugin:api');

    // The user's entry is untouched, and the registry doesn't claim it.
    const servers = await readServersFile(fs);
    expect(servers.servers['reports-plugin:api'].url).toBe('https://user.example.com/mcp');
    const file = await readPluginsFile(fs);
    expect(file.plugins['reports-plugin'].mcpServerNames).toEqual([]);
  });

  it('remove: leaves a user-added MCP server alone even if listed in mcpServerNames', async () => {
    await writeFixturePlugin({ mcp: true });
    await runCmd(['install', 'reports-plugin']);
    // Simulate the entry losing its plugin ownership (user re-added it).
    await setServer(
      'reports-plugin:api',
      { url: 'https://user.example.com/mcp', pluginOrigin: undefined },
      fs
    );

    const r = await runCmd(['remove', 'reports-plugin']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('0 removed');
    expect((await readServersFile(fs)).servers['reports-plugin:api']).toBeDefined();
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

  describe('GitHub sources', () => {
    function repoZip(prefix = ''): Uint8Array {
      const p = prefix ? `${prefix}/` : '';
      return zipSync({
        [`repo-main/${p}plugin.json`]: new TextEncoder().encode(
          JSON.stringify({
            $schema: PLUGIN_MANIFEST_SCHEMA_ID,
            name: 'gh-plugin',
            version: '0.1.0',
          })
        ),
        [`repo-main/${p}skills/greet/SKILL.md`]: new TextEncoder().encode(
          '---\nname: greet\ndescription: Say hello\n---\n# Greet\n'
        ),
      });
    }

    function zipFetch(zip: Uint8Array): SecureFetch {
      return vi.fn(async (url: string) =>
        url.startsWith('https://codeload.github.com/')
          ? { status: 200, statusText: 'OK', headers: {}, body: zip, url }
          : { status: 404, statusText: 'Not Found', headers: {}, body: '', url }
      ) as unknown as SecureFetch;
    }

    it('install: downloads owner/repo into the managed sources dir', async () => {
      const fetchMock = zipFetch(repoZip());
      const r = await runCmd(['install', 'acme/repo'], fetchMock);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Installed agent plugin "gh-plugin" v0.1.0 from acme/repo');
      expect(r.stdout).toContain('greet');

      const file = await readPluginsFile(fs);
      const entry = file.plugins['gh-plugin'];
      expect(entry.root).toBe(`${PLUGIN_SOURCES_DIR}/acme--repo`);
      expect(entry.source).toBe('acme/repo');
      expect(await fs.exists(`${entry.root}/plugin.json`)).toBe(true);

      const skills = await discoverSkills(fs);
      expect(skills.filter((s) => s.source === 'plugin').map((s) => s.name)).toEqual(['greet']);
    });

    it('install: supports /tree/<branch>/<subdir> URLs', async () => {
      const fetchMock = zipFetch(repoZip('plugins/gh-plugin'));
      const r = await runCmd(
        ['install', 'https://github.com/acme/repo/tree/main/plugins/gh-plugin'],
        fetchMock
      );
      expect(r.exitCode).toBe(0);
      const entry = (await readPluginsFile(fs)).plugins['gh-plugin'];
      expect(entry.root).toBe(`${PLUGIN_SOURCES_DIR}/acme--repo--plugins-gh-plugin`);
      expect(entry.source).toBe('acme/repo@main/plugins/gh-plugin');
      expect(await fs.exists(`${entry.root}/skills/greet/SKILL.md`)).toBe(true);
    });

    it('install: prefers an existing local directory over a GitHub ref', async () => {
      await fs.mkdir('/workspace/acme/repo', { recursive: true });
      const fetchMock = vi.fn() as unknown as SecureFetch;
      const r = await runCmd(['install', 'acme/repo'], fetchMock);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('rejected'); // local dir has no plugin.json
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('install: errors without a configured fetch', async () => {
      const r = await runCmd(['install', 'acme/repo']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('no network fetch configured');
    });

    it('install: rejects a repo without plugin.json and leaves nothing behind', async () => {
      const zip = zipSync({
        'repo-main/README.md': new TextEncoder().encode('# hi\n'),
      });
      const r = await runCmd(['install', 'acme/repo'], zipFetch(zip));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('no plugin.json found');
      expect(await fs.exists(`${PLUGIN_SOURCES_DIR}/acme--repo`)).toBe(false);
    });

    it('install: cleans up the extracted dir when validation rejects', async () => {
      const zip = zipSync({
        'repo-main/plugin.json': new TextEncoder().encode(JSON.stringify({ name: 'Bad--Name' })),
      });
      const r = await runCmd(['install', 'acme/repo'], zipFetch(zip));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('rejected');
      expect(await fs.exists(`${PLUGIN_SOURCES_DIR}/acme--repo`)).toBe(false);
    });

    it('install: surfaces download failures', async () => {
      const fetchMock = vi.fn(async (url: string) => ({
        status: 500,
        statusText: 'Server Error',
        headers: {},
        body: '',
        url,
      })) as unknown as SecureFetch;
      const r = await runCmd(['install', 'acme/repo'], fetchMock);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('failed to download acme/repo');
    });

    it('validate: dry-runs a GitHub ref without installing', async () => {
      const r = await runCmd(['validate', 'acme/repo'], zipFetch(repoZip()));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('plugin validate: OK — "gh-plugin"');
      expect((await readPluginsFile(fs)).plugins['gh-plugin']).toBeUndefined();
      expect(await fs.exists(`${PLUGIN_SOURCES_DIR}/acme--repo`)).toBe(false);
    });

    it('remove: deletes the managed source dir of a GitHub install', async () => {
      await runCmd(['install', 'acme/repo'], zipFetch(repoZip()));
      const root = `${PLUGIN_SOURCES_DIR}/acme--repo`;
      expect(await fs.exists(root)).toBe(true);

      const r = await runCmd(['remove', 'gh-plugin']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`files:       removed (${root})`);
      expect(await fs.exists(root)).toBe(false);
    });
  });
});
