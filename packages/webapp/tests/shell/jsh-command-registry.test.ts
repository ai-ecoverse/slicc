import type { Command } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  JshCommandRegistry,
  type JshCommandRegistryHost,
} from '../../src/shell/jsh-command-registry.js';
import type { ScriptCatalog } from '../../src/shell/script-catalog.js';

function host(overrides: Partial<JshCommandRegistryHost> = {}): JshCommandRegistryHost {
  const registered: Command[] = [];
  const builtins = new Set<string>(['echo']);
  return {
    bash: { registerCommand: (cmd: Command) => registered.push(cmd) } as never,
    scriptCatalog: {
      getJshIndex: vi.fn(async () => ({ commands: new Map(), collisions: [] })),
      getJshCommands: vi.fn(async () => new Map()),
      getWorkflowCommands: vi.fn(async () => new Map()),
      getWasmCommands: vi.fn(async () => new Map()),
    } as unknown as ScriptCatalog,
    discoveryFs: { readFile: vi.fn(), exists: vi.fn(), walk: vi.fn() } as never,
    vfsAdapter: {} as never,
    cwd: '/',
    lastEnv: { PATH: '/workspace/skills' },
    umask: 0o022,
    builtinCommandNames: builtins,
    isCommandAllowed: () => true,
    wrapCommandForDispatch: (command) => command,
    path: () => '/workspace/skills',
    buildJshProcessConfig: () => undefined,
    gateNativeCommand: async () => null,
    gitIdentity: async () => ({ name: 'User', email: 'user@example.com' }),
    ...overrides,
  };
}

describe('JshCommandRegistry', () => {
  it('coalesces overlapping syncs and re-runs when a second request arrives in-flight', async () => {
    let release!: () => void;
    const firstScan = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scans = 0;
    const scriptCatalog = {
      getJshIndex: vi.fn(async () => {
        scans += 1;
        if (scans === 1) await firstScan;
        return { commands: new Map([['hello', '/workspace/skills/hello.jsh']]), collisions: [] };
      }),
      getJshCommands: vi.fn(async () => new Map()),
      getWorkflowCommands: vi.fn(async () => new Map()),
      getWasmCommands: vi.fn(async () => new Map()),
    } as unknown as ScriptCatalog;
    const registry = new JshCommandRegistry(host({ scriptCatalog }));

    const a = registry.syncJshCommands();
    void registry.syncJshCommands();
    expect(scans).toBe(1);
    release();
    await a;
    await vi.waitFor(() => expect(scans).toBe(2));
    expect(registry.registeredJshCommands.get('hello')).toBe('/workspace/skills/hello.jsh');
  });

  it('does not register a .jsh that shadows a built-in name', async () => {
    const scriptCatalog = {
      getJshIndex: vi.fn(async () => ({
        commands: new Map([['echo', '/workspace/skills/echo.jsh']]),
        collisions: [],
      })),
      getJshCommands: vi.fn(async () => new Map()),
      getWorkflowCommands: vi.fn(async () => new Map()),
      getWasmCommands: vi.fn(async () => new Map()),
    } as unknown as ScriptCatalog;
    const registerCommand = vi.fn();
    const registry = new JshCommandRegistry(
      host({
        scriptCatalog,
        bash: { registerCommand } as never,
      })
    );
    await registry.syncJshCommands();
    expect(registerCommand).not.toHaveBeenCalled();
    expect(registry.registeredJshCommands.has('echo')).toBe(false);
  });

  it('filters workflow names through the allow-list', async () => {
    const scriptCatalog = {
      getJshIndex: vi.fn(async () => ({ commands: new Map(), collisions: [] })),
      getJshCommands: vi.fn(async () => new Map()),
      getWorkflowCommands: vi.fn(
        async () =>
          new Map([
            ['ok', { path: '/workspace/.workflows/ok.workflow.js', kind: 'saved' }],
            ['nope', { path: '/workspace/.workflows/nope.workflow.js', kind: 'saved' }],
          ])
      ),
      getWasmCommands: vi.fn(async () => new Map()),
    } as unknown as ScriptCatalog;
    const registry = new JshCommandRegistry(
      host({
        scriptCatalog,
        isCommandAllowed: (name) => name === 'ok',
      })
    );
    await expect(registry.getWorkflowCommandNames()).resolves.toEqual(['ok']);
  });
});
