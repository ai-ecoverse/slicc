import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVpodCommand,
  extractPodName,
  parseStartArgs,
} from '../../../src/shell/supplemental-commands/vpod-command.js';
import type {
  VpodCommandResult,
  VpodModule,
  VpodNetworkCapabilities,
  VpodSandbox,
  VpodSandboxOptions,
} from '../../../src/shell/supplemental-commands/vpod-loader.js';
import { VPOD_PINNED_VERSION } from '../../../src/shell/supplemental-commands/vpod-loader.js';
import {
  getPod,
  resetPodRegistryForTests,
} from '../../../src/shell/supplemental-commands/vpod-pods.js';

afterEach(() => {
  resetPodRegistryForTests();
});

describe('parseStartArgs', () => {
  it('applies defaults', () => {
    const result = parseStartArgs([]);
    expect('parsed' in result).toBe(true);
    if (!('parsed' in result)) return;
    expect(result.parsed).toEqual({ name: 'pod0', net: false });
  });

  it('parses the full flag set', () => {
    const result = parseStartArgs(['--name', 'builder', '--snapshot', 'node-20', '--net']);
    expect('parsed' in result).toBe(true);
    if (!('parsed' in result)) return;
    expect(result.parsed).toEqual({ name: 'builder', snapshot: 'node-20', net: true });
  });

  it('rejects unknown flags and missing values', () => {
    expect('error' in parseStartArgs(['--frobnicate'])).toBe(true);
    expect('error' in parseStartArgs(['--name'])).toBe(true);
    expect('error' in parseStartArgs(['--snapshot'])).toBe(true);
  });
});

describe('extractPodName', () => {
  it('defaults to pod0 and strips the name pair', () => {
    expect(extractPodName([])).toEqual({ name: 'pod0', rest: [] });
    expect(extractPodName(['-n', 'x', '--port', '80'])).toEqual({
      name: 'x',
      rest: ['--port', '80'],
    });
    expect(extractPodName(['--name', 'y'])).toEqual({ name: 'y', rest: [] });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle with a fake SDK
// ---------------------------------------------------------------------------

const OFFLINE_CAPS: VpodNetworkCapabilities = {
  backend: 'none',
  rawTcp: false,
  arbitraryPorts: false,
  corsRestricted: true,
  byteFaithfulHeaders: false,
  udp: false,
  strippedRequestHeaders: [],
};

type FakeSandbox = VpodSandbox & {
  runs: Array<[string, { timeout?: number } | undefined]>;
  closed: boolean;
};

function makeFakeSandbox(runImpl?: (command: string) => Promise<VpodCommandResult>): FakeSandbox {
  const sandbox: FakeSandbox = {
    runs: [],
    closed: false,
    snapshotId: 'snap-default',
    network: OFFLINE_CAPS,
    commands: {
      run: vi.fn(async (command: string, options?: { timeout?: number }) => {
        sandbox.runs.push([command, options]);
        if (runImpl) return runImpl(command);
        return { stdout: `ran:${command}\n`, stderr: '', exitCode: 0, success: true };
      }),
    },
    close: vi.fn(async () => {
      sandbox.closed = true;
    }),
  };
  return sandbox;
}

function makeSdk(sandbox: FakeSandbox, capture?: { options?: VpodSandboxOptions }): VpodModule {
  return {
    sdk: {
      Sandbox: {
        create: vi.fn(async (options?: VpodSandboxOptions) => {
          if (capture) capture.options = options;
          return sandbox;
        }),
      },
      explainUnreachable: (caps, port) =>
        caps.backend === 'none' ? `port ${port} unreachable: no network backend` : null,
    },
    version: VPOD_PINNED_VERSION,
  };
}

function makeCtx() {
  return {
    fs: {
      resolvePath: (base: string, path: string) =>
        path.startsWith('/') ? path : `${base}/${path}`,
      exists: async () => false,
      readFile: async () => '',
      readFileBuffer: async () => new Uint8Array(),
      writeFile: async () => {},
      mkdir: async () => {},
      stat: async () => ({ isDirectory: false }),
    },
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: new Uint8Array(),
  } as never;
}

function makePm() {
  const exits: Array<[number, unknown]> = [];
  const procs: Array<{ pid: number; abort: AbortController }> = [];
  let nextPid = 100;
  const pm = {
    spawn: vi.fn(() => {
      const proc = { pid: nextPid++, abort: new AbortController() };
      procs.push(proc);
      return proc;
    }),
    exit: vi.fn((pid: number, code: unknown) => {
      exits.push([pid, code]);
    }),
    signal: vi.fn(),
  };
  return { pm: pm as never, exits, procs };
}

describe('vpod command lifecycle (fake SDK)', () => {
  it('prints help with no args and fails on unknown subcommands', async () => {
    const cmd = createVpodCommand();
    const help = await cmd.execute([], makeCtx());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('vpod start');
    expect(help.stdout).toContain('ipk add @capsule-run/vpod@');

    const bad = await cmd.execute(['frobnicate'], makeCtx());
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('unknown subcommand');
  });

  it('reports the SDK version through the injected loader', async () => {
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(makeFakeSandbox()) });
    const result = await cmd.execute(['--version'], makeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`vpod ${VPOD_PINNED_VERSION}\n`);
  });

  it('boots a pod, registers it, and reports it in ls', async () => {
    const sandbox = makeFakeSandbox();
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    const result = await cmd.execute(['start'], makeCtx());
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pod 'pod0' running (snapshot snap-default");
    expect(getPod('pod0')).toBeDefined();

    const ls = await cmd.execute(['ls'], makeCtx());
    expect(ls.stdout).toContain('pod0');
    expect(ls.stdout).toContain('snap-default');
  });

  it('threads snapshot and network options into Sandbox.create', async () => {
    const capture: { options?: VpodSandboxOptions } = {};
    const cmd = createVpodCommand({
      loadSdk: async () => makeSdk(makeFakeSandbox(), capture),
    });
    const result = await cmd.execute(
      ['start', '--name', 'builder', '--snapshot', 'node-20', '--net'],
      makeCtx()
    );
    expect(result.exitCode).toBe(0);
    expect(capture.options).toEqual({ snapshot: 'node-20', network: true });
    expect(getPod('builder')).toBeDefined();
  });

  it('omits unset create options entirely', async () => {
    const capture: { options?: VpodSandboxOptions } = {};
    const cmd = createVpodCommand({
      loadSdk: async () => makeSdk(makeFakeSandbox(), capture),
    });
    await cmd.execute(['start'], makeCtx());
    expect(capture.options).toEqual({});
  });

  it('rejects a duplicate pod name', async () => {
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(makeFakeSandbox()) });
    await cmd.execute(['start'], makeCtx());
    const dup = await cmd.execute(['start'], makeCtx());
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toContain('already running');
  });

  it('surfaces Sandbox.create failures as boot errors', async () => {
    const cmd = createVpodCommand({
      loadSdk: async () => ({
        sdk: {
          Sandbox: {
            create: async () => {
              throw new Error('snapshot pull failed: 404');
            },
          },
          explainUnreachable: () => null,
        },
        version: VPOD_PINNED_VERSION,
      }),
    });
    const result = await cmd.execute(['start'], makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boot failed: snapshot pull failed: 404');
    expect(getPod('pod0')).toBeUndefined();
  });

  it('runs commands in a started pod and passes the guest result through', async () => {
    const sandbox = makeFakeSandbox(async () => ({
      stdout: 'Linux pod0 6.6 riscv64\n',
      stderr: 'warning: no tty\n',
      exitCode: 3,
      success: false,
    }));
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    await cmd.execute(['start'], makeCtx());
    const result = await cmd.execute(['run', 'uname', '-a'], makeCtx());
    expect(sandbox.runs).toEqual([['uname -a', undefined]]);
    expect(result.stdout).toBe('Linux pod0 6.6 riscv64\n');
    expect(result.stderr).toBe('warning: no tty\n');
    expect(result.exitCode).toBe(3);
  });

  it('auto-boots the default pod on run, but never a named pod', async () => {
    const sandbox = makeFakeSandbox();
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });

    const result = await cmd.execute(['run', 'echo', 'hi'], makeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ran:echo hi\n');
    expect(getPod('pod0')).toBeDefined();

    const named = await cmd.execute(['run', '--name', 'builder', 'echo', 'hi'], makeCtx());
    expect(named.exitCode).toBe(1);
    expect(named.stderr).toContain("no pod named 'builder'");
  });

  it('recognizes flags only before the command and honors --', async () => {
    const sandbox = makeFakeSandbox();
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    await cmd.execute(['start'], makeCtx());

    await cmd.execute(['run', '--timeout', '5', 'sleep', '10'], makeCtx());
    expect(sandbox.runs.at(-1)).toEqual(['sleep 10', { timeout: 5 }]);

    // Flags after the first command word belong to the guest command.
    await cmd.execute(['run', 'node', 'script.js', '--name', 'foo', '--timeout', '9'], makeCtx());
    expect(sandbox.runs.at(-1)).toEqual(['node script.js --name foo --timeout 9', undefined]);

    // `--` terminates flag parsing explicitly.
    await cmd.execute(['run', '--', '--weird-first-arg'], makeCtx());
    expect(sandbox.runs.at(-1)).toEqual(['--weird-first-arg', undefined]);
  });

  it('re-quotes argv for the guest shell (host shell already ate the quotes)', async () => {
    const sandbox = makeFakeSandbox();
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    await cmd.execute(['start'], makeCtx());

    // The host shell delivers `python3 -c "print(6*7)"` as bare argv —
    // without re-quoting the guest sh chokes on the parens.
    await cmd.execute(['run', 'python3', '-c', 'print(6*7)'], makeCtx());
    expect(sandbox.runs.at(-1)).toEqual(["python3 -c 'print(6*7)'", undefined]);

    // sh -c payloads survive as one quoted token, embedded quotes escaped.
    await cmd.execute(['run', 'sh', '-c', "echo 'a b' && pwd"], makeCtx());
    expect(sandbox.runs.at(-1)).toEqual([`sh -c 'echo '\\''a b'\\'' && pwd'`, undefined]);
  });

  it('rejects bad --timeout values and empty commands', async () => {
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(makeFakeSandbox()) });
    expect((await cmd.execute(['run', '--timeout', 'soon', 'ls'], makeCtx())).exitCode).toBe(1);
    expect((await cmd.execute(['run', '--timeout', '0', 'ls'], makeCtx())).exitCode).toBe(1);
    const empty = await cmd.execute(['run'], makeCtx());
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('run requires a command');
  });

  it('fails fast when the pod is already running a command', async () => {
    let release: (value: VpodCommandResult) => void = () => {};
    const gate = new Promise<VpodCommandResult>((resolve) => {
      release = resolve;
    });
    const sandbox = makeFakeSandbox(() => gate);
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    await cmd.execute(['start'], makeCtx());

    const first = cmd.execute(['run', 'sleep', '5'], makeCtx());
    await Promise.resolve();
    const second = await cmd.execute(['run', 'echo', 'hi'], makeCtx());
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('busy');

    release({ stdout: '', stderr: '', exitCode: 0, success: true });
    expect((await first).exitCode).toBe(0);

    // The busy flag clears once the in-flight command finishes.
    const third = await cmd.execute(['run', 'echo', 'again'], makeCtx());
    expect(third.exitCode).toBe(0);
  });

  it('reports network capabilities and per-port reachability', async () => {
    const sandbox = makeFakeSandbox();
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    await cmd.execute(['start'], makeCtx());

    const caps = await cmd.execute(['net'], makeCtx());
    expect(caps.exitCode).toBe(0);
    expect(caps.stdout).toContain('backend:          none');
    expect(caps.stdout).toContain('cross-origin isolation');

    const port = await cmd.execute(['net', '--port', '443'], makeCtx());
    expect(port.stdout).toContain('port 443: port 443 unreachable: no network backend');

    expect((await cmd.execute(['net', '--frob'], makeCtx())).exitCode).toBe(1);
    expect((await cmd.execute(['net', '--port', 'x'], makeCtx())).exitCode).toBe(1);
  });

  it('stops a pod: closes the sandbox and unregisters it', async () => {
    const sandbox = makeFakeSandbox();
    const cmd = createVpodCommand({ loadSdk: async () => makeSdk(sandbox) });
    await cmd.execute(['start'], makeCtx());

    const result = await cmd.execute(['stop'], makeCtx());
    expect(result.exitCode).toBe(0);
    expect(sandbox.closed).toBe(true);
    expect(getPod('pod0')).toBeUndefined();

    const again = await cmd.execute(['stop'], makeCtx());
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("no pod named 'pod0'");
  });

  it('registers with the ProcessManager and tears down on abort', async () => {
    const sandbox = makeFakeSandbox();
    const { pm, exits, procs } = makePm();
    const cmd = createVpodCommand({
      loadSdk: async () => makeSdk(sandbox),
      processManager: pm,
    });

    const result = await cmd.execute(['start'], makeCtx());
    expect(result.stdout).toContain('pid 100');
    expect(getPod('pod0')?.pid).toBe(100);

    procs[0].abort.abort();
    await vi.waitFor(() => {
      expect(sandbox.closed).toBe(true);
    });
    expect(getPod('pod0')).toBeUndefined();
    expect(exits).toEqual([[100, null]]);
  });

  it('reports pm exit on explicit stop as well', async () => {
    const sandbox = makeFakeSandbox();
    const { pm, exits } = makePm();
    const cmd = createVpodCommand({
      loadSdk: async () => makeSdk(sandbox),
      processManager: pm,
    });
    await cmd.execute(['start'], makeCtx());
    await cmd.execute(['stop'], makeCtx());
    expect(sandbox.closed).toBe(true);
    expect(exits).toEqual([[100, null]]);
  });
});
