import { describe, expect, it } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import type { SyncSabTransport } from '../../../src/kernel/realm/sync-sab-bridge.js';
import {
  evaluateGlue,
  glueBody,
  kernelSys,
  ownValue,
  SyscallError,
  signalMasks,
} from '../../../src/kernel/wasm-realm/process-runtime.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function transport(reply: (req: unknown) => SyncFsResult): SyncSabTransport {
  return { call: (req) => reply(req) };
}

describe('kernelSys', () => {
  it('turns fd-read / fd-write results into bytes and counts', () => {
    const seen: unknown[] = [];
    const sys = kernelSys(
      transport((req) => {
        seen.push(req);
        return (req as { op: string }).op === 'fd-read'
          ? { ok: true, kind: 'bytes', bytes: bytes('in') }
          : { ok: true, kind: 'json', json: 5 };
      })
    );
    expect(text(sys.read(0, 16))).toBe('in');
    expect(sys.write(1, bytes('hello'))).toBe(5);
    expect(seen).toEqual([
      { op: 'fd-read', fd: 0, max: 16 },
      { op: 'fd-write', fd: 1, body: bytes('hello') },
    ]);
  });

  it('closes, makes pipes, and polls through the kernel', () => {
    const seen: unknown[] = [];
    const replies: Record<string, SyncFsResult> = {
      'fd-close': { ok: true, kind: 'void' },
      'fd-pipe': { ok: true, kind: 'json', json: [3, 4] },
      'fd-poll': {
        ok: true,
        kind: 'json',
        json: { readable: true, writable: false, hangup: false },
      },
    };
    const sys = kernelSys(
      transport((req) => {
        seen.push(req);
        return replies[(req as { op: string }).op]!;
      })
    );
    sys.close(3);
    expect(sys.pipe()).toEqual([3, 4]);
    expect(sys.poll(3)).toEqual({ readable: true, writable: false, hangup: false });
    expect(seen).toEqual([{ op: 'fd-close', fd: 3 }, { op: 'fd-pipe' }, { op: 'fd-poll', fd: 3 }]);
  });

  it('raises a kernel errno as SyscallError', () => {
    const sys = kernelSys(transport(() => ({ ok: false, errno: 'EPIPE', message: 'EPIPE' })));
    expect(() => sys.write(1, bytes('x'))).toThrow(SyscallError);
    expect(() => sys.read(0, 1)).toThrow(expect.objectContaining({ code: 'EPIPE' }));
  });
});

describe('glueBody', () => {
  it("drops an extensionless output's shebang line and keeps other glue as is", () => {
    expect(glueBody('#!/usr/bin/env node\nvar Module = 1;\n')).toBe('var Module = 1;\n');
    expect(glueBody('var Module = 1;')).toBe('var Module = 1;');
  });
});

describe('evaluateGlue', () => {
  const glue = [
    '#!/usr/bin/env node',
    "var Module = typeof Module != 'undefined' ? Module : {};",
    'var ENV = { HOME: "/" };',
    'var FS = { own: true };',
    'function callMain(args) { return args.length; }',
    'function sliccRunMain(args) { return -args.length; }',
    'var PIPEFS = { createPipe() {} };',
  ].join('\n');

  it('fills ENV and takes FS and callMain from the glue when it exports neither', () => {
    const module: { sliccEnv: object; FS?: { own: boolean }; callMain?: (a: string[]) => number } =
      { sliccEnv: { A: '1' } };
    evaluateGlue(glue, module);
    expect(module.FS).toEqual({ own: true });
    expect(module.callMain?.(['x', 'y'])).toBe(2);
    const scoped = module as {
      sliccRunMain?: (a: string[]) => number;
      PIPEFS?: object;
      sliccSigpipe?: () => number;
    };
    expect(scoped.sliccRunMain?.(['x'])).toBe(-1);
    expect(scoped.PIPEFS).toHaveProperty('createPipe');
    expect(scoped.sliccSigpipe?.()).toBe(-1); // no disposition query linked in
  });

  it('replaces the aborting accessors an assertions build puts on unexported symbols', () => {
    // Emscripten with ASSERTIONS: reading an unexported runtime symbol aborts.
    const guarded = [
      "var Module = typeof Module != 'undefined' ? Module : {};",
      ...['FS', 'callMain', 'PIPEFS'].map(
        (name) =>
          `Object.defineProperty(Module, '${name}', { configurable: true, get() { throw new Error('Aborted(${name} was not exported)'); } });`
      ),
      'var ENV = {};',
      'var FS = { own: true };',
      'function callMain(args) { return args.length; }',
      'var PIPEFS = { createPipe() {} };',
    ].join('\n');
    const module = { sliccEnv: {} } as {
      sliccEnv: object;
      FS?: object;
      callMain?: (a: string[]) => number;
      PIPEFS?: object;
    };
    evaluateGlue(guarded, module);
    expect(module.FS).toEqual({ own: true });
    expect(module.callMain?.(['a'])).toBe(1);
    expect(module.PIPEFS).toHaveProperty('createPipe');
  });

  it('ownValue() reads a data property and never an accessor', () => {
    const module = { FS: 1 };
    Object.defineProperty(module, 'PIPEFS', {
      get() {
        throw new Error('Aborted');
      },
    });
    expect(ownValue(module, 'FS')).toBe(1);
    expect(ownValue(module, 'PIPEFS')).toBeUndefined();
    expect(ownValue(module, 'nothing')).toBeUndefined();
  });

  it('keeps what the program exported', () => {
    const exported = { exported: true };
    const module = { sliccEnv: {}, FS: exported } as { sliccEnv: object; FS?: object };
    evaluateGlue(glue, module);
    expect(module.FS).toBe(exported);
  });

  it("asks the program's SIGPIPE disposition once it is instantiated", () => {
    const module: { sliccEnv: object; sliccSigpipe?: () => number } = { sliccEnv: {} };
    // Emscripten assigns the export after instantiation, i.e. after the glue body ran.
    evaluateGlue(
      'var ENV = {}; var _slicc_sigpipe; Module.late = () => { _slicc_sigpipe = () => 1; };',
      module
    );
    expect(module.sliccSigpipe?.()).toBe(-1);
    (module as unknown as { late: () => void }).late();
    expect(module.sliccSigpipe?.()).toBe(1);
  });

  it('keeps what the glue exports itself', () => {
    const exported = { exported: true };
    const module = { sliccEnv: {}, FS: exported };
    evaluateGlue(glue, module);
    expect(module.FS).toBe(exported);
  });

  it('runs a glue without a filesystem', () => {
    const module: { sliccEnv: object; FS?: object } = { sliccEnv: {} };
    evaluateGlue('var ENV = {};', module);
    expect(module.FS).toBeUndefined();
  });
});

describe('signalMasks', () => {
  it('reads the masks, including signal 31 (a negative int32)', () => {
    const masks = [(1 << 2) | (1 << 31), 1 << 20, 1 << 2];
    expect(signalMasks({ sliccSigMask: (which) => masks[which]! })).toEqual({
      caught: (1 << 2) | (1 << 31),
      ignored: 1 << 20,
      restart: 1 << 2,
    });
  });

  it('is null for a program without signal support (-1, or no hook)', () => {
    expect(signalMasks({ sliccSigMask: () => -1 })).toBeNull();
    expect(signalMasks({})).toBeNull();
  });
});
