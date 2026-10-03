import { describe, expect, it, vi } from 'vitest';
import {
  mainModule,
  nameFrame,
  parseFunctionNames,
  sidecarNames,
} from '../../../../src/kernel/wasm-realm/wasi/wasm-names.js';

/** A `name` section payload: a module name (subsection 0), then function names (subsection 1). */
function namePayload(functions: Array<[number, string]>): Uint8Array {
  const enc = new TextEncoder();
  const str = (s: string) => [enc.encode(s).length, ...enc.encode(s)];
  const sub = (id: number, body: number[]) => [id, body.length, ...body];
  const fns = [functions.length, ...functions.flatMap(([i, n]) => [i, ...str(n)])];
  return new Uint8Array([...sub(0, str('rustc')), ...sub(1, fns)]);
}

describe('parseFunctionNames', () => {
  it('reads the function-names subsection and skips the others', () => {
    const names = parseFunctionNames(
      namePayload([
        [3, 'rustc_driver::main'],
        [70, 'llvm::foo()'],
      ])
    );
    expect([...names]).toEqual([
      [3, 'rustc_driver::main'],
      [70, 'llvm::foo()'],
    ]);
  });

  it('refuses a truncated payload', () => {
    const whole = namePayload([[3, 'rustc_driver::main']]);
    expect(() => parseFunctionNames(whole.subarray(0, whole.length - 4))).toThrow(RangeError);
  });
});

describe('nameFrame', () => {
  const name = (i: number) => (i === 1674 ? 'Build.Step.zigProcessUpdate' : undefined);

  it('names an unnamed wasm frame of the module as V8 would from the section', () => {
    expect(
      nameFrame('    at wasm://wasm/00ce402e:wasm-function[1674]:0x196785', '00ce402e', name)
    ).toBe(
      '    at Build.Step.zigProcessUpdate (wasm://wasm/00ce402e:wasm-function[1674]:0x196785)'
    );
  });

  it('leaves frames it cannot name, frames that are named already, and other modules’ frames', () => {
    const unknown = '    at wasm://wasm/00ce402e:wasm-function[9]:0x10';
    expect(nameFrame(unknown, '00ce402e', name)).toBe(unknown);
    const named = '    at debug.defaultPanic (wasm://wasm/00ce402e:wasm-function[1674]:0x24b977)';
    expect(nameFrame(named, '00ce402e', name)).toBe(named);
    const side = '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[1674]:0x10';
    expect(nameFrame(side, '00ce402e', name)).toBe(side);
  });
});

describe('mainModule', () => {
  it('is the module of the bottom wasm frame, the one JS called', () => {
    expect(
      mainModule([
        'RuntimeError: unreachable',
        '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[3]:0x10',
        '    at wasm://wasm/00ce402e:wasm-function[12]:0x40',
        '    at _start (wasm://wasm/00ce402e:wasm-function[1]:0x20)',
        '    at runWasiProcess (worker.js:1:2)',
      ])
    ).toBe('00ce402e');
  });

  it('is unknown when the stack was cut short above the JS caller, or has no wasm frame', () => {
    expect(
      mainModule([
        'RuntimeError: unreachable',
        '    at wasm://wasm/00ce402e:wasm-function[12]:0x40',
        '    at wasm://wasm/libfoo-7a7a7a7a:wasm-function[3]:0x10',
      ])
    ).toBeUndefined();
    expect(mainModule(['Error: x', '    at f (a.js:1:1)'])).toBeUndefined();
  });
});

describe('sidecarNames', () => {
  it('reads the sidecar once, on first use', () => {
    const read = vi.fn(() => namePayload([[5, 'main']]));
    const name = sidecarNames(read, '/bin/rustc.wasm.names');
    expect(read).not.toHaveBeenCalled();
    expect(name(5)).toBe('main');
    expect(name(6)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('/bin/rustc.wasm.names');
  });

  it('never fails a backtrace: an unreadable or broken sidecar names nothing', () => {
    expect(
      sidecarNames(() => {
        throw new Error('ENOENT');
      }, '/x')(1)
    ).toBeUndefined();
    expect(sidecarNames(() => new Uint8Array([1, 200]), '/x')(1)).toBeUndefined();
  });
});
