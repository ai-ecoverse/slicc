import type { ResolvedCommandContext } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSliccCommand } from '../../../src/shell/supplemental-commands/slicc-command.js';

const hoisted = vi.hoisted(() => ({
  client: null as { call: ReturnType<typeof vi.fn> } | null,
}));

vi.mock('../../../src/kernel/panel-rpc.js', () => ({
  getPanelRpcClient: () => hoisted.client,
}));

const JOIN_URL = 'https://tray.example.com/join/token123';

/** Default results per op, overridable per test. */
function fakeRpc(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'slicc-attach': { name: 'slicc-1', joinUrl: JOIN_URL, trayId: 'tray-1', state: 'connected' },
    'slicc-list': { attachments: [] },
    'slicc-detach': { detached: true },
    'slicc-prompt': { stdout: '', stderr: '', exitCode: 0 },
    'slicc-exec': { stdout: '', stderr: '', exitCode: 0 },
    'slicc-watch': { stdout: '', stderr: '', exitCode: 0 },
    'slicc-cancel': { ok: true },
  };
  const call = vi.fn(async (op: string, _payload?: unknown) => ({ ...defaults, ...overrides })[op]);
  hoisted.client = { call };
  return call;
}

/** `slicc` reads `ctx.signal`, `ctx.stdin` and `ctx.fs.readFile`. */
function ctx(
  opts: { signal?: AbortSignal; stdin?: string; files?: Record<string, string> } = {}
): ResolvedCommandContext {
  return {
    signal: opts.signal,
    stdin: opts.stdin,
    fs: {
      readFile: async (path: string) => {
        const content = opts.files?.[path];
        if (content === undefined) throw new Error('ENOENT: no such file or directory');
        return content;
      },
    },
  } as unknown as ResolvedCommandContext;
}

/** Payload of the first call to `op`. */
function payloadOf(call: ReturnType<typeof vi.fn>, op: string): Record<string, unknown> {
  const entry = call.mock.calls.find((args) => args[0] === op);
  if (!entry) throw new Error(`expected a ${op} call; got ${JSON.stringify(call.mock.calls)}`);
  return entry[1] as Record<string, unknown>;
}

describe('slicc command', () => {
  beforeEach(() => {
    hoisted.client = null;
  });

  it('has the correct name', () => {
    expect(createSliccCommand().name).toBe('slicc');
  });

  describe('help', () => {
    it('shows top-level help for no args, --help and -h', async () => {
      for (const args of [[], ['--help'], ['-h']]) {
        const r = await createSliccCommand().execute(args, ctx());
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('slicc - talk to another SLICC leader as a client');
      }
    });

    // Review pattern 14: `--help` after a verb must print help, not perform the
    // verb with "--help" as its argument.
    it.each([
      ['prompt', 'send one chat turn'],
      ['exec', "run a command in a remote leader's virtual shell"],
      ['watch', "tail a remote SLICC agent's live output"],
    ])('shows %s help without running it', async (verb, marker) => {
      const call = fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL, verb, '--help'], ctx());
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(marker);
      expect(call).not.toHaveBeenCalled();
    });

    it('never sends "--help" as a prompt', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'prompt', '--help'], ctx());
      expect(call.mock.calls.map((c) => c[0])).not.toContain('slicc-prompt');
    });
  });

  describe('argument parsing', () => {
    it('rejects an unknown flag rather than ignoring it', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL, 'exec', '--bogus', 'ls'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('unknown flag: --bogus');
    });

    it('rejects an unknown verb', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL, 'follow', 'sh', '-c'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('unknown verb: follow');
    });

    it('requires a verb', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('missing verb');
    });

    it('rejects a non-positive --timeout', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute(
        [JOIN_URL, 'exec', '--timeout', '0', 'ls'],
        ctx()
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('--timeout requires a positive number of seconds');
    });

    // The whole point of stopping option parsing at the verb's first positional:
    // a remote command's own flags must survive verbatim.
    it("does not eat the remote command's flags", async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', 'ls', '-la', '--color'], ctx());
      expect(payloadOf(call, 'slicc-exec').command).toBe('ls -la --color');
    });

    it('accepts flags before the target', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute(['--name', 'lab', JOIN_URL, 'exec', 'ls'], ctx());
      expect(payloadOf(call, 'slicc-attach').name).toBe('lab');
    });

    it('passes --cwd through to exec', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', '--cwd', '/tmp', 'ls'], ctx());
      expect(payloadOf(call, 'slicc-exec').cwd).toBe('/tmp');
    });

    it('passes --steer through to prompt', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'prompt', '--steer', 'stop'], ctx());
      expect(payloadOf(call, 'slicc-prompt').steer).toBe(true);
    });

    it('requires text for prompt and a command for exec', async () => {
      fakeRpc();
      for (const verb of ['prompt', 'exec']) {
        const r = await createSliccCommand().execute([JOIN_URL, verb], ctx());
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(`slicc ${verb}: missing`);
      }
    });
  });

  describe('target resolution', () => {
    it('attaches when the target is a join URL', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', 'ls'], ctx());
      expect(payloadOf(call, 'slicc-attach').joinUrl).toBe(JOIN_URL);
      expect(payloadOf(call, 'slicc-exec').name).toBe('slicc-1');
    });

    // A bare word is an existing attachment name — dialing it would be a typo
    // silently turning into a new connection attempt.
    it('uses a non-URL target as an attachment name without attaching', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute(['lab', 'exec', 'ls'], ctx());
      expect(call.mock.calls.map((c) => c[0])).not.toContain('slicc-attach');
      expect(payloadOf(call, 'slicc-exec').name).toBe('lab');
    });

    it('surfaces an attach failure instead of running the verb', async () => {
      const call = vi.fn(async (op: string, _payload?: unknown) => {
        if (op === 'slicc-attach') throw new Error('TRAY_LEADER_NOT_ELECTED');
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      hoisted.client = { call };
      const r = await createSliccCommand().execute([JOIN_URL, 'exec', 'ls'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('TRAY_LEADER_NOT_ELECTED');
      expect(call.mock.calls.map((c) => c[0])).not.toContain('slicc-exec');
    });
  });

  describe('curl-style text arguments', () => {
    it('reads a prompt from a VFS file with @path', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute(
        [JOIN_URL, 'prompt', '@/workspace/brief.md'],
        ctx({ files: { '/workspace/brief.md': 'ship it' } })
      );
      expect(payloadOf(call, 'slicc-prompt').text).toBe('ship it');
    });

    it('reports a missing @path file', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL, 'prompt', '@/nope.md'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('cannot read /nope.md');
    });

    it.each(['-', '@-'])('reads a prompt from piped stdin with %s', async (arg) => {
      const call = fakeRpc();
      await createSliccCommand().execute(
        [JOIN_URL, 'prompt', arg],
        ctx({ stdin: 'here is a diff' })
      );
      expect(payloadOf(call, 'slicc-prompt').text).toBe('here is a diff');
    });

    it('errors when - is given but nothing was piped', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL, 'prompt', '-'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('no piped stdin');
    });

    // Matches the CLI's `readTextArg`: indirection fires for a SINGLE arg only,
    // so a multi-word prompt containing an @word stays literal.
    it('keeps a multi-word prompt literal even when it contains @word', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute(
        [JOIN_URL, 'prompt', 'ask', '@alice', 'about', 'it'],
        ctx({ files: { alice: 'SHOULD NOT BE READ' } })
      );
      expect(payloadOf(call, 'slicc-prompt').text).toBe('ask @alice about it');
    });
  });

  describe('exec stdin', () => {
    it('forwards piped stdin as base64', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', 'cat'], ctx({ stdin: 'hello' }));
      expect(payloadOf(call, 'slicc-exec').stdin).toBe(btoa('hello'));
    });

    // `exec -` already consumed stdin as the COMMAND; sending the same bytes on
    // as the remote command's stdin would double-feed them.
    it('does not re-send stdin that was consumed as the command', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', '-'], ctx({ stdin: 'uname -a' }));
      const payload = payloadOf(call, 'slicc-exec');
      expect(payload.command).toBe('uname -a');
      expect(payload.stdin).toBeUndefined();
    });
  });

  describe('watch', () => {
    it('defaults to a 30s window and converts --for to ms', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'watch'], ctx());
      expect(payloadOf(call, 'slicc-watch').durationMs).toBe(30_000);

      hoisted.client = { call: fakeRpc() };
      const call2 = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'watch', '--for', '60'], ctx());
      expect(payloadOf(call2, 'slicc-watch').durationMs).toBe(60_000);
    });

    it('passes a scoop jid positional and --until-idle', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'watch', '--until-idle', 'scoop-abc'], ctx());
      const payload = payloadOf(call, 'slicc-watch');
      expect(payload.scoopJid).toBe('scoop-abc');
      expect(payload.untilIdle).toBe(true);
    });

    it('runs without a command argument', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute([JOIN_URL, 'watch'], ctx());
      expect(r.exitCode).toBe(0);
    });
  });

  describe('list and detach', () => {
    it('reports an empty roster with a hint', async () => {
      fakeRpc({ 'slicc-list': { attachments: [] } });
      const r = await createSliccCommand().execute(['list'], ctx());
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('No attachments.');
    });

    it('lists attachments with state and tray id', async () => {
      fakeRpc({
        'slicc-list': {
          attachments: [{ name: 'lab', joinUrl: JOIN_URL, state: 'connected', trayId: 'tray-9' }],
        },
      });
      const r = await createSliccCommand().execute(['list'], ctx());
      expect(r.stdout).toContain('lab (connected)');
      expect(r.stdout).toContain(JOIN_URL);
      expect(r.stdout).toContain('tray-9');
    });

    it('rejects a stray argument to list', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute(['list', 'extra'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('unexpected argument: extra');
    });

    it('detaches by name', async () => {
      const call = fakeRpc();
      const r = await createSliccCommand().execute(['detach', 'lab'], ctx());
      expect(r.exitCode).toBe(0);
      expect(payloadOf(call, 'slicc-detach').name).toBe('lab');
    });

    it('reports an unknown detach name as an error', async () => {
      fakeRpc({ 'slicc-detach': { detached: false } });
      const r = await createSliccCommand().execute(['detach', 'nope'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('no such attachment: nope');
    });

    it('requires a name or --all', async () => {
      fakeRpc();
      const r = await createSliccCommand().execute(['detach'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('missing attachment name');
    });

    it('detaches every attachment with --all', async () => {
      const call = fakeRpc({
        'slicc-list': {
          attachments: [
            { name: 'a', joinUrl: JOIN_URL, state: 'connected', trayId: null },
            { name: 'b', joinUrl: JOIN_URL, state: 'connected', trayId: null },
          ],
        },
      });
      const r = await createSliccCommand().execute(['detach', '--all'], ctx());
      expect(r.exitCode).toBe(0);
      const detached = call.mock.calls
        .filter((c) => c[0] === 'slicc-detach')
        .map((c) => (c[1] as { name: string }).name);
      expect(detached).toEqual(['a', 'b']);
    });

    it('detaches after the verb with --once', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', '--once', 'ls'], ctx());
      expect(payloadOf(call, 'slicc-detach').name).toBe('slicc-1');
    });

    it('keeps the attachment warm without --once', async () => {
      const call = fakeRpc();
      await createSliccCommand().execute([JOIN_URL, 'exec', 'ls'], ctx());
      expect(call.mock.calls.map((c) => c[0])).not.toContain('slicc-detach');
    });
  });

  describe('result handling', () => {
    it('passes through stdout, stderr and exit code', async () => {
      fakeRpc({ 'slicc-exec': { stdout: 'out', stderr: 'warn', exitCode: 3 } });
      const r = await createSliccCommand().execute([JOIN_URL, 'exec', 'false'], ctx());
      expect(r).toEqual({ stdout: 'out', stderr: 'warn', exitCode: 3 });
    });

    it('prefixes a transport error and never reports success for it', async () => {
      fakeRpc({
        'slicc-exec': { stdout: '', stderr: '', exitCode: 0, error: 'connection lost: detached' },
      });
      const r = await createSliccCommand().execute([JOIN_URL, 'exec', 'ls'], ctx());
      expect(r.stderr).toContain('slicc: connection lost: detached');
      expect(r.exitCode).toBe(1);
    });

    it('cancels the run when the shell aborts', async () => {
      const controller = new AbortController();
      const call = vi.fn(async (op: string, _payload?: unknown) => {
        if (op === 'slicc-attach') {
          return { name: 'slicc-1', joinUrl: JOIN_URL, trayId: 't', state: 'connected' };
        }
        if (op === 'slicc-exec') {
          controller.abort();
          await Promise.resolve();
          return { stdout: '', stderr: '', exitCode: 130, error: 'interrupted' };
        }
        return { ok: true };
      });
      hoisted.client = { call };
      await createSliccCommand().execute(
        [JOIN_URL, 'exec', 'sleep 100'],
        ctx({ signal: controller.signal })
      );
      expect(call.mock.calls.map((c) => c[0])).toContain('slicc-cancel');
    });

    it('reports a missing panel-RPC bridge rather than throwing', async () => {
      hoisted.client = null;
      const r = await createSliccCommand().execute([JOIN_URL, 'exec', 'ls'], ctx());
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('not available in this environment');
    });
  });
});
