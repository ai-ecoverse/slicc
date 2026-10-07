import { describe, expect, it } from 'vitest';
import { renderConsentPage } from '../../../src/shell/mcp/serve-consent.js';
import {
  bindMcpRunner,
  discoverCli,
  handleMcpServeOp,
  setPublication,
} from '../../../src/shell/mcp/serve-runtime.js';
import type { TextFs } from '../../../src/shell/mcp/serve-store.js';

const JIRA_HELP = `usage: jira <command>

Commands:
  get <issue>   Fetch one issue
  detect        Guess the site

OPTIONS:
  --json   Print JSON
`;

function memoryFs(): TextFs {
  const files = new Map<string, string>();
  return {
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) return Promise.reject(new Error(`missing ${path}`));
      return Promise.resolve(value);
    },
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
  };
}

describe('discoverCli', () => {
  it('derives tools from help and keeps global flags off of group candidates', async () => {
    const calls: string[][] = [];
    const discovered = await discoverCli('/workspace/jira.jsh', undefined, (path, argv) => {
      calls.push([path, ...argv]);
      if (argv[0] === '--mcp') return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      if (argv[0] === 'detect') {
        return Promise.resolve({ stdout: JIRA_HELP, stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: JIRA_HELP, stderr: '', exitCode: 0 });
    });
    expect(discovered.name).toBe('jira');
    expect(discovered.commands.map((command) => command.path)).toEqual([['get'], ['detect']]);
    expect(
      discovered.commands
        .find((command) => command.path[0] === 'get')
        ?.flags.map((flag) => flag.name)
    ).toEqual(['json']);
    expect(calls.some((call) => call[1] === 'detect' && call[2] === '--help')).toBe(true);
  });

  it('prefers a --mcp descriptor', async () => {
    const discovered = await discoverCli('/workspace/gh.jsh', 'gh', () =>
      Promise.resolve({
        stdout: JSON.stringify({
          commands: [{ name: 'pr list', description: 'List', positionals: [], flags: [] }],
        }),
        stderr: '',
        exitCode: 0,
      })
    );
    expect(discovered.name).toBe('gh');
    expect(discovered.commands[0]?.path).toEqual(['pr', 'list']);
  });
});

describe('handleMcpServeOp', () => {
  it('runs a derived tool as spawn argv and renders consent from the local set', async () => {
    const argv: string[][] = [];
    bindMcpRunner((_path, args) => {
      argv.push(args);
      return Promise.resolve({ stdout: 'PROJ-1\n', stderr: '', exitCode: 0 });
    });
    const discovered = await discoverCli('/workspace/jira.jsh', undefined, (_path, args) => {
      if (args[0] === '--mcp') return Promise.resolve({ stdout: '', stderr: 'no', exitCode: 1 });
      if (args[0] === 'detect') return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      return Promise.resolve({ stdout: JIRA_HELP, stderr: '', exitCode: 0 });
    });
    await setPublication(memoryFs(), {
      url: 'https://7f3a9c.sliccy.now/mcp',
      token: 'token-1',
      grantGeneration: 3,
      clis: [discovered],
    });
    const called = await handleMcpServeOp(
      'rpc',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'jira_get', arguments: { issue: 'PROJ-1' } },
      })
    );
    expect(argv).toEqual([['get', 'PROJ-1']]);
    expect(JSON.parse(called.body).result.content[0].text).toContain('PROJ-1');
    const consent = await handleMcpServeOp(
      'consent',
      JSON.stringify({ pendingId: 'pend-1', generation: 3, clientName: 'Claude <dev>' })
    );
    expect(consent.contentType).toContain('text/html');
    expect(consent.body).toContain('name="generation" value="3"');
    expect(consent.body).toContain('jira_invoke');
    expect(consent.body).toContain('Claude &lt;dev&gt;');
    expect(consent.body).toContain('skill token');
  });
});

describe('renderConsentPage', () => {
  it('groups tools and posts a real form', () => {
    const html = renderConsentPage({
      pendingId: 'p"1',
      generation: 2,
      clientName: 'SLICC',
      tools: [
        { name: 'jira_get', description: 'Fetch', cli: 'jira' },
        { name: 'gh_pr_list', description: 'List', cli: 'gh' },
      ],
    });
    expect(html).toContain('action="/oauth/decision"');
    expect(html).toContain('value="p&quot;1"');
    expect(html).toContain('<h2>jira</h2>');
    expect(html).toContain('<h2>gh</h2>');
  });
});
