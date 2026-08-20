import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chordToScancodes,
  createV86Command,
  DEFAULT_VGA_MEMORY_MIB,
  extractVmName,
  MAX_VGA_MEMORY_MIB,
  parseStartArgs,
} from '../../../src/shell/supplemental-commands/v86-command.js';
import {
  DEFAULT_MEMORY_MIB,
  dumpTextScreen,
  getVm,
  instrumentVm,
  MAX_MEMORY_MIB,
  registerVm,
  resetVmRegistryForTests,
  SERIAL_BUFFER_CAP,
  type VmRecord,
} from '../../../src/shell/supplemental-commands/v86-vm.js';
import type { V86Emulator, V86Module } from '../../../src/shell/supplemental-commands/v86-wasm.js';
import { V86_PINNED_VERSION } from '../../../src/shell/supplemental-commands/v86-wasm.js';

afterEach(() => {
  resetVmRegistryForTests();
});

describe('parseStartArgs', () => {
  it('applies defaults and requires bootable media', () => {
    const missing = parseStartArgs([]);
    expect(missing.ok).toBe(false);

    const result = parseStartArgs(['-cdrom', 'alpine.iso']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.name).toBe('vm0');
    expect(result.parsed.memoryMib).toBe(DEFAULT_MEMORY_MIB);
    expect(result.parsed.cdrom).toBe('alpine.iso');
    expect(result.parsed.nographic).toBe(false);
  });

  it('parses the full QEMU-flavored flag set', () => {
    const result = parseStartArgs([
      '-n',
      'test-vm',
      '-m',
      '256',
      '-kernel',
      'bzImage',
      '-initrd',
      'rootfs.img',
      '-append',
      'console=ttyS0',
      '-boot',
      'd',
      '-nographic',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toMatchObject({
      name: 'test-vm',
      memoryMib: 256,
      kernel: 'bzImage',
      initrd: 'rootfs.img',
      append: 'console=ttyS0',
      boot: 'd',
      nographic: true,
    });
  });

  it('rejects bad names, oversized memory, and unknown flags', () => {
    expect(parseStartArgs(['-n', 'has space', '-hda', 'x.img']).ok).toBe(false);
    expect(parseStartArgs(['-m', String(MAX_MEMORY_MIB + 1), '-hda', 'x.img']).ok).toBe(false);
    expect(parseStartArgs(['-m', '-5', '-hda', 'x.img']).ok).toBe(false);
    expect(parseStartArgs(['-frobnicate', '-hda', 'x.img']).ok).toBe(false);
    expect(parseStartArgs(['-boot', 'q', '-hda', 'x.img']).ok).toBe(false);
  });

  it('accepts -state as bootable media with -fs9p and -net (copy.sh Arch profile)', () => {
    const result = parseStartArgs([
      '-state',
      'arch_state.bin.zst',
      '-fs9p',
      'https://i.copy.sh/arch/',
      '-net',
      'virtio',
      '-m',
      '512',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed).toMatchObject({
      state: 'arch_state.bin.zst',
      fs9p: 'https://i.copy.sh/arch/',
      net: 'virtio',
      memoryMib: 512,
    });
  });

  it('rejects non-http fs9p URLs and unknown NIC models', () => {
    expect(parseStartArgs(['-state', 's.bin', '-fs9p', '/local/dir']).ok).toBe(false);
    expect(parseStartArgs(['-state', 's.bin', '-net', 'e1000']).ok).toBe(false);
  });

  it('parses -net <model>,relay=fetch and rejects unknown relay options', () => {
    const relayed = parseStartArgs(['-hda', 'x.img', '-net', 'ne2k,relay=fetch']);
    expect(relayed.ok).toBe(true);
    if (relayed.ok) expect(relayed.parsed).toMatchObject({ net: 'ne2k', netRelay: 'fetch' });

    const plain = parseStartArgs(['-hda', 'x.img', '-net', 'virtio']);
    expect(plain.ok && plain.parsed.netRelay).toBeUndefined();

    expect(parseStartArgs(['-hda', 'x.img', '-net', 'ne2k,relay=ws']).ok).toBe(false);
    expect(parseStartArgs(['-hda', 'x.img', '-net', 'e1000,relay=fetch']).ok).toBe(false);
  });

  it('parses -vga and enforces the video-memory cap', () => {
    const dflt = parseStartArgs(['-hda', 'x.img']);
    expect(dflt.ok && dflt.parsed.vgaMemoryMib).toBe(DEFAULT_VGA_MEMORY_MIB);
    const raised = parseStartArgs(['-hda', 'x.img', '-vga', '16']);
    expect(raised.ok && raised.parsed.vgaMemoryMib).toBe(16);
    expect(parseStartArgs(['-hda', 'x.img', '-vga', String(MAX_VGA_MEMORY_MIB + 1)]).ok).toBe(
      false
    );
    expect(parseStartArgs(['-hda', 'x.img', '-vga', '0']).ok).toBe(false);
  });
});

describe('extractVmName', () => {
  it('defaults to vm0 and strips the -n pair', () => {
    expect(extractVmName(['hello'])).toEqual({ name: 'vm0', rest: ['hello'] });
    expect(extractVmName(['-n', 'alt', 'hello', 'world'])).toEqual({
      name: 'alt',
      rest: ['hello', 'world'],
    });
    expect(extractVmName(['--name', 'x'])).toEqual({ name: 'x', rest: [] });
  });
});

describe('chordToScancodes', () => {
  it('maps single named keys to press+release', () => {
    expect(chordToScancodes('enter')).toEqual([0x1c, 0x9c]);
    expect(chordToScancodes('esc')).toEqual([0x01, 0x81]);
    expect(chordToScancodes('f12')).toEqual([0x58, 0xd8]);
  });

  it('wraps modifiers around the final key', () => {
    // ctrl down, c down, c up, ctrl up
    expect(chordToScancodes('ctrl-c')).toEqual([0x1d, 0x2e, 0xae, 0x9d]);
    expect(chordToScancodes('alt-tab')).toEqual([0x38, 0x0f, 0x8f, 0xb8]);
  });

  it('handles extended-code keys and ctrl-alt-del', () => {
    expect(chordToScancodes('delete')).toEqual([0xe0, 0x53, 0xe0, 0xd3]);
    expect(chordToScancodes('ctrl-alt-del')).toEqual([
      0x1d, 0x38, 0xe0, 0x53, 0xe0, 0xd3, 0xb8, 0x9d,
    ]);
  });

  it('returns null for unknown chords', () => {
    expect(chordToScancodes('bogus-key')).toBeNull();
    expect(chordToScancodes('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle with a mocked emulator
// ---------------------------------------------------------------------------

type FakeEmulator = V86Emulator & {
  listeners: Map<string, (arg: unknown) => void>;
  busSends: Array<[string, unknown]>;
  running: boolean;
};

function makeFakeEmulator(): FakeEmulator {
  const fake: FakeEmulator = {
    listeners: new Map(),
    busSends: [],
    running: false,
    run: vi.fn(async () => {
      fake.running = true;
    }),
    stop: vi.fn(async () => {
      fake.running = false;
    }),
    destroy: vi.fn(async () => {}),
    add_listener: (event, listener) => {
      fake.listeners.set(event, listener);
    },
    is_running: () => fake.running,
    save_state: vi.fn(async () => new ArrayBuffer(16)),
    restore_state: vi.fn(async () => {}),
    keyboard_send_text: vi.fn(),
    keyboard_send_scancodes: vi.fn(),
    serial0_send: vi.fn(),
    bus: {
      send: (name: string, data?: unknown) => {
        fake.busSends.push([name, data]);
      },
    },
    screen_adapter: {
      set_mode: vi.fn(),
      set_size_graphical: vi.fn(),
      update_buffer: vi.fn(),
      get_text_screen: () => ['SLICC boot menu   ', 'ok                '],
    },
    // Marks the engine as already initialized — v86Start skips the
    // `emulator-loaded` wait when `emulator.v86` is present.
    v86: {},
  };
  return fake;
}

function makeEngine(
  emulator: FakeEmulator,
  capture?: { options?: Record<string, unknown> }
): V86Module {
  return {
    V86: function FakeV86(options: Record<string, unknown>) {
      if (capture) capture.options = options;
      return emulator;
    } as unknown as V86Module['V86'],
    wasmModule: {} as WebAssembly.Module,
    version: V86_PINNED_VERSION,
  };
}

function makeCtx(files: Record<string, Uint8Array> = {}) {
  const written = new Map<string, Uint8Array | string>();
  return {
    written,
    ctx: {
      fs: {
        resolvePath: (base: string, path: string) =>
          path.startsWith('/') ? path : `${base}/${path}`,
        exists: async (path: string) => path in files || written.has(path),
        readFile: async (path: string) => new TextDecoder().decode(files[path]),
        readFileBuffer: async (path: string) => files[path] ?? (written.get(path)! as Uint8Array),
        writeFile: async (path: string, data: Uint8Array | string) => {
          written.set(path, data);
        },
        mkdir: async () => {},
        stat: async () => ({ isDirectory: false }),
      },
      cwd: '/workspace',
      env: new Map<string, string>(),
      stdin: new Uint8Array(),
    } as never,
  };
}

const BIOS_FILES = {
  '/workspace/.v86/seabios.bin': new Uint8Array([1]),
  '/workspace/.v86/vgabios.bin': new Uint8Array([2]),
  '/workspace/alpine.iso': new Uint8Array([3, 4]),
};

async function startVm(emulator: FakeEmulator, extraArgs: string[] = []) {
  const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
  const { ctx } = makeCtx(BIOS_FILES);
  return cmd.execute(['start', '-cdrom', 'alpine.iso', ...extraArgs], ctx);
}

describe('v86 command lifecycle (mocked engine)', () => {
  it('boots a VM, registers it, and reports it in ls', async () => {
    const emulator = makeFakeEmulator();
    const result = await startVm(emulator);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("VM 'vm0' booting");
    expect(emulator.run).toHaveBeenCalled();
    expect(getVm('vm0')).toBeDefined();

    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const ls = await cmd.execute(['ls'], makeCtx().ctx);
    expect(ls.stdout).toContain('vm0');
    expect(ls.stdout).toContain('running');
  });

  it('waits for emulator-loaded before instrumenting and running (async engine init)', async () => {
    const emulator = makeFakeEmulator();
    delete (emulator as { v86?: unknown }).v86;
    const startPromise = startVm(emulator);
    // Let v86Start reach the emulator-loaded wait, then simulate the
    // engine finishing its async init.
    await vi.waitFor(() => {
      expect(emulator.listeners.has('emulator-loaded')).toBe(true);
    });
    expect(emulator.run).not.toHaveBeenCalled();
    emulator.listeners.get('emulator-loaded')!(undefined);
    const result = await startPromise;
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(emulator.run).toHaveBeenCalled();
    // Instrumentation happened post-load: serial listener is attached.
    expect(emulator.listeners.has('serial0-output-byte')).toBe(true);
  });

  it('threads relay=fetch into net_device and reroutes the relay fetch through the proxy', async () => {
    const emulator = makeFakeEmulator();
    const originalFetch = vi.fn();
    emulator.network_adapter = { fetch: originalFetch };
    const proxied = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
      body: new Uint8Array([104, 105]),
      url: 'https://github.com/',
    }));
    const capture: { options?: Record<string, unknown> } = {};
    const cmd = createV86Command({
      loadEngine: async () => makeEngine(emulator, capture),
      proxiedFetch: proxied,
    });
    const { ctx } = makeCtx(BIOS_FILES);
    const result = await cmd.execute(
      ['start', '-cdrom', 'alpine.iso', '-net', 'ne2k,relay=fetch'],
      ctx
    );
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(capture.options?.net_device).toEqual({ type: 'ne2k', relay_url: 'fetch' });
    // The adapter's own fetch prop was replaced with the proxied shim.
    expect(emulator.network_adapter.fetch).not.toBe(originalFetch);

    const resp = await emulator.network_adapter.fetch!('http://github.com/', {
      method: 'GET',
      headers: new Headers({ accept: 'text/html' }),
    });
    // Guest plain-http upgraded to https before hitting the proxy.
    expect(proxied).toHaveBeenCalledWith('https://github.com/', {
      method: 'GET',
      headers: { accept: 'text/html' },
      body: undefined,
    });
    expect(resp.status).toBe(200);
    // The shim returns a real Headers (Response-compatible iteration API),
    // not the proxy's plain record.
    expect(resp.headers).toBeInstanceOf(Headers);
    expect((resp.headers as Headers).get('content-type')).toBe('text/html');
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(new Uint8Array([104, 105]));
  });

  it('keeps relay localhost targets on http and latin1-encodes POST bodies', async () => {
    const emulator = makeFakeEmulator();
    emulator.network_adapter = { fetch: vi.fn() };
    const proxied = vi.fn(async () => ({
      status: 204,
      statusText: 'No Content',
      headers: {},
      body: new Uint8Array(),
      url: 'http://localhost:8080/upload',
    }));
    const cmd = createV86Command({
      loadEngine: async () => makeEngine(emulator),
      proxiedFetch: proxied,
    });
    const { ctx } = makeCtx(BIOS_FILES);
    await cmd.execute(['start', '-cdrom', 'alpine.iso', '-net', 'virtio,relay=fetch'], ctx);

    await emulator.network_adapter.fetch!('http://localhost:8080/upload', {
      method: 'POST',
      body: new Uint8Array([0x00, 0x80, 0xff]),
    });
    expect(proxied).toHaveBeenCalledWith('http://localhost:8080/upload', {
      method: 'POST',
      headers: {},
      body: '\u0000\u0080\u00ff',
    });
  });

  it('fails the boot when relay=fetch finds no network adapter', async () => {
    const emulator = makeFakeEmulator();
    const cmd = createV86Command({
      loadEngine: async () => makeEngine(emulator),
      proxiedFetch: vi.fn(),
    });
    const { ctx } = makeCtx(BIOS_FILES);
    const result = await cmd.execute(
      ['start', '-cdrom', 'alpine.iso', '-net', 'ne2k,relay=fetch'],
      ctx
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('relay=fetch');
    expect(getVm('vm0')).toBeUndefined();
  });

  it('threads -state / -fs9p / -net into the emulator options (copy.sh Arch boot)', async () => {
    const emulator = makeFakeEmulator();
    const capture: { options?: Record<string, unknown> } = {};
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator, capture) });
    const { ctx } = makeCtx({
      ...BIOS_FILES,
      '/workspace/arch_state.bin.zst': new Uint8Array([40, 181, 47, 253]),
    });
    const result = await cmd.execute(
      [
        'start',
        '-state',
        'arch_state.bin.zst',
        '-fs9p',
        'https://i.copy.sh/arch/',
        '-net',
        'virtio',
        '-m',
        '512',
      ],
      ctx
    );
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(capture.options?.initial_state).toBeDefined();
    expect(capture.options?.filesystem).toEqual({ baseurl: 'https://i.copy.sh/arch/' });
    expect(capture.options?.net_device).toEqual({ type: 'virtio' });
    expect(capture.options?.memory_size).toBe(512 * 1024 * 1024);
    // State resumes skip BIOS staging — the snapshot carries machine state.
    expect(capture.options?.bios).toBeUndefined();
  });

  it('boots from -state without BIOS blobs present', async () => {
    const emulator = makeFakeEmulator();
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx } = makeCtx({ '/workspace/saved.bin': new Uint8Array([1, 2, 3]) });
    const result = await cmd.execute(['start', '-state', 'saved.bin'], ctx);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces the BIOS download hint when blobs are missing', async () => {
    const cmd = createV86Command({ loadEngine: async () => makeEngine(makeFakeEmulator()) });
    const { ctx } = makeCtx({ '/workspace/alpine.iso': new Uint8Array([1]) });
    const result = await cmd.execute(['start', '-cdrom', 'alpine.iso'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('BIOS images not found');
    expect(result.stderr).toContain('seabios.bin');
  });

  it('rejects duplicate VM names', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const dup = await startVm(makeFakeEmulator());
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toContain('already running');
  });

  it('types text, sends key chords, and drives the mouse', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx } = makeCtx();

    const typed = await cmd.execute(['type', 'root\\n'], ctx);
    expect(typed.exitCode).toBe(0);
    expect(emulator.keyboard_send_text).toHaveBeenCalledWith('root\n');

    await cmd.execute(['key', 'ctrl-c'], ctx);
    expect(emulator.keyboard_send_scancodes).toHaveBeenCalledWith([0x1d, 0x2e, 0xae, 0x9d]);

    await cmd.execute(['mouse', 'move', '10', '5'], ctx);
    expect(emulator.busSends).toContainEqual(['mouse-delta', [10, -5]]);

    await cmd.execute(['mouse', 'click', 'right'], ctx);
    expect(emulator.busSends).toContainEqual(['mouse-click', [false, false, true]]);
    expect(emulator.busSends).toContainEqual(['mouse-click', [false, false, false]]);
  });

  it('dumps the text screen and buffers serial output', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx } = makeCtx();

    const text = await cmd.execute(['text'], ctx);
    expect(text.stdout).toBe('SLICC boot menu\nok\n');

    const serialListener = emulator.listeners.get('serial0-output-byte')!;
    for (const ch of 'login:') serialListener(ch.charCodeAt(0));
    const serial = await cmd.execute(['serial'], ctx);
    expect(serial.stdout).toContain('login:');

    await cmd.execute(['serial', '--send', 'root\\n'], ctx);
    expect(emulator.serial0_send).toHaveBeenCalledWith('root\n');
  });

  it('saves and restores state through the VFS', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx, written } = makeCtx();

    const saved = await cmd.execute(['state', 'save', '/tmp/vm.state'], ctx);
    expect(saved.exitCode).toBe(0);
    expect(written.has('/tmp/vm.state')).toBe(true);

    const loaded = await cmd.execute(['state', 'load', '/tmp/vm.state'], ctx);
    expect(loaded.exitCode).toBe(0);
    expect(emulator.restore_state).toHaveBeenCalled();
  });

  it('`stop --help` prints help and leaves the VM running', async () => {
    // Regression: only `args[0]` was checked for --help, so asking `stop`
    // for help powered the VM off.
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const help = await cmd.execute(['stop', '--help'], makeCtx().ctx);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('v86 stop');
    expect(emulator.destroy).not.toHaveBeenCalled();
    expect(getVm('vm0')).toBeDefined();
  });

  it('`-append --help` is a kernel cmdline, not a help request', async () => {
    // Same review point as playwright's `--body --help`: a value-taking
    // flag's value must not be read as a help flag.
    const cmd = createV86Command({ loadEngine: async () => makeEngine(makeFakeEmulator()) });
    const result = await cmd.execute(['start', '-append', '--help'], makeCtx().ctx);
    // No bootable media -> the start parser rejects it; the point is that it
    // got to the parser at all instead of printing usage.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no bootable media');
  });

  it('`type --help` prints help; `type -- --help` types the literal flag', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx } = makeCtx();

    const help = await cmd.execute(['type', '--help'], ctx);
    expect(help.exitCode).toBe(0);
    expect(emulator.keyboard_send_text).not.toHaveBeenCalled();

    // `--` is the escape hatch for free-text payloads that look like flags.
    const typed = await cmd.execute(['type', '--', '--help'], ctx);
    expect(typed.exitCode).toBe(0);
    expect(emulator.keyboard_send_text).toHaveBeenCalledWith('--help');
  });

  it('stops and unregisters a VM', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const stopped = await cmd.execute(['stop'], makeCtx().ctx);
    expect(stopped.exitCode).toBe(0);
    expect(emulator.stop).toHaveBeenCalled();
    expect(emulator.destroy).toHaveBeenCalled();
    expect(getVm('vm0')).toBeUndefined();
  });

  it('still destroys the emulator when stop() rejects', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    emulator.stop = vi.fn(async () => {
      throw new Error('wedged guest');
    });
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const stopped = await cmd.execute(['stop'], makeCtx().ctx);
    expect(stopped.exitCode).toBe(0);
    expect(emulator.destroy).toHaveBeenCalled();
    expect(getVm('vm0')).toBeUndefined();
  });

  it('errors cleanly on subcommands against a missing VM', async () => {
    const cmd = createV86Command({ loadEngine: async () => makeEngine(makeFakeEmulator()) });
    const result = await cmd.execute(['type', 'hello'], makeCtx().ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no VM named 'vm0'");
  });

  it('serves the screen into a VFS directory and stops on --stop', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx, written } = makeCtx();

    const served = await cmd.execute(['serve'], ctx);
    expect(served.stderr).toBe('');
    expect(served.exitCode).toBe(0);
    expect(served.stdout).toContain('/tmp/v86-serve-vm0');
    expect(served.stdout).toContain('serve /tmp/v86-serve-vm0');
    expect(written.has('/tmp/v86-serve-vm0/index.html')).toBe(true);
    // Text-mode guest: the pump writes screen.txt + state.json.
    expect(written.has('/tmp/v86-serve-vm0/screen.txt')).toBe(true);
    const state = JSON.parse(written.get('/tmp/v86-serve-vm0/state.json') as string);
    expect(state).toMatchObject({ name: 'vm0', mode: 'text' });
    expect(getVm('vm0')?.serve?.fps).toBe(2);

    const dup = await cmd.execute(['serve'], ctx);
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toContain('already serving');

    const stopped = await cmd.execute(['serve', '--stop'], ctx);
    expect(stopped.exitCode).toBe(0);
    expect(getVm('vm0')?.serve).toBeNull();
  });

  it('validates --fps and clears the serve pump on VM stop', async () => {
    const emulator = makeFakeEmulator();
    await startVm(emulator);
    const cmd = createV86Command({ loadEngine: async () => makeEngine(emulator) });
    const { ctx } = makeCtx();

    const bad = await cmd.execute(['serve', '--fps', '99'], ctx);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('--fps');

    const served = await cmd.execute(['serve', '--fps', '5'], ctx);
    expect(served.exitCode).toBe(0);
    expect(getVm('vm0')?.serve?.fps).toBe(5);

    await cmd.execute(['stop'], ctx);
    expect(getVm('vm0')).toBeUndefined();
  });

  it('reports the engine version via --version', async () => {
    const cmd = createV86Command({ loadEngine: async () => makeEngine(makeFakeEmulator()) });
    const result = await cmd.execute(['--version'], makeCtx().ctx);
    expect(result.stdout).toContain(`v86 ${V86_PINNED_VERSION}`);
  });
});

describe('vm registry instrumentation', () => {
  it('caps the serial ring buffer', () => {
    const emulator = makeFakeEmulator();
    const record: VmRecord = {
      name: 'cap-test',
      emulator,
      engineVersion: V86_PINNED_VERSION,
      pid: null,
      startedAt: Date.now(),
      bootArgv: ['v86', 'start'],
      serial: { buffer: '' },
      screen: { mode: 'text', width: 0, height: 0, frame: null },
      serve: null,
    };
    instrumentVm(record);
    registerVm(record);
    const listener = emulator.listeners.get('serial0-output-byte')!;
    for (let i = 0; i < SERIAL_BUFFER_CAP + 100; i++) listener(65);
    expect(record.serial.buffer.length).toBe(SERIAL_BUFFER_CAP);
  });

  it('tracks screen mode and frame through the wrapped adapter', () => {
    const emulator = makeFakeEmulator();
    const record: VmRecord = {
      name: 'screen-test',
      emulator,
      engineVersion: V86_PINNED_VERSION,
      pid: null,
      startedAt: Date.now(),
      bootArgv: ['v86', 'start'],
      serial: { buffer: '' },
      screen: { mode: 'text', width: 0, height: 0, frame: null },
      serve: null,
    };
    instrumentVm(record);
    emulator.screen_adapter!.set_mode!(true);
    expect(record.screen.mode).toBe('graphical');
    emulator.screen_adapter!.set_size_graphical!(640, 480, 640, 480);
    expect(record.screen.width).toBe(640);
    const data = new Uint8ClampedArray(640 * 480 * 4);
    emulator.screen_adapter!.update_buffer!([
      {
        image_data: { data, width: 640, height: 480 },
        screen_x: 0,
        screen_y: 0,
        buffer_x: 0,
        buffer_y: 0,
        buffer_width: 640,
        buffer_height: 480,
      },
    ]);
    expect(record.screen.frame?.width).toBe(640);
    expect(dumpTextScreen(record)).toBe('SLICC boot menu\nok');
  });
});
