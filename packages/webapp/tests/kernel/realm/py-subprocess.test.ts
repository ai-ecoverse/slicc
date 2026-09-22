/**
 * The Pyodide `subprocess` shim against real Pyodide. The exec bridge is a
 * fake that records each request and answers from a small command table, so
 * the tests pin both what Python sends and how replies surface in Python.
 */
import { resolve } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPySubprocessModule,
  installPySubprocess,
} from '../../../src/kernel/realm/py-subprocess.js';
import type {
  SyncExecOptions,
  SyncExecXhrBridge,
} from '../../../src/kernel/realm/sync-exec-xhr-bridge.js';

const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide');

interface ExecCall {
  command: string | string[];
  opts: SyncExecOptions;
}

let pyodide: PyodideInterface;
const calls: ExecCall[] = [];
const events: string[] = [];
let failWith: string | undefined;

const exec: SyncExecXhrBridge = {
  run(command, opts = {}) {
    calls.push({ command, opts });
    events.push('exec');
    if (failWith) throw Object.assign(new Error('boom'), { code: failWith });
    const argv = Array.isArray(command) ? command : command.split(' ');
    switch (argv[0]) {
      case 'echo':
        return { stdout: `${argv.slice(1).join(' ')}\n`, stderr: '', exitCode: 0 };
      case 'cat':
        return { stdout: opts.input ?? '', stderr: '', exitCode: 0 };
      case 'fail':
        return { stdout: 'partial', stderr: 'bad things\n', exitCode: 3 };
      default:
        return { stdout: '', stderr: `${argv[0]}: command not found\n`, exitCode: 127 };
    }
  },
};

beforeAll(async () => {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  installPySubprocess(pyodide, {
    exec,
    beforeExec: () => events.push('flush'),
    afterExec: () => events.push('invalidate'),
  });
}, 60_000);

beforeEach(() => {
  calls.length = 0;
  events.length = 0;
  failWith = undefined;
});

const py = (code: string): unknown => pyodide.runPython(code);

describe('Pyodide subprocess shim', () => {
  it('runs argv through the exec bridge and captures stdout', () => {
    expect(py(`import subprocess; subprocess.check_output(['echo', 'hi there'], text=True)`)).toBe(
      'hi there\n'
    );
    expect(calls[0].command).toEqual(['echo', 'hi there']);
    expect(events).toEqual(['flush', 'exec', 'invalidate']);
  });

  it('passes cwd, the full os.environ and input', () => {
    py(`
import os, subprocess
os.environ['EM_CONFIG'] = '/x/.emscripten'
r = subprocess.run(['cat'], input=b'piped', capture_output=True, cwd='/tmp')
`);
    expect(py('r.stdout')?.toString()).toContain('piped');
    expect(calls[0].opts.cwd).toBe('/tmp');
    expect(calls[0].opts.input).toBe('piped');
    expect(calls[0].opts.env?.EM_CONFIG).toBe('/x/.emscripten');
  });

  it('reports the exit code and raises CalledProcessError with check=True', () => {
    py(`
import subprocess
r = subprocess.run(['fail'], capture_output=True, text=True)
try:
    subprocess.check_call(['fail'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    raised = None
except subprocess.CalledProcessError as e:
    raised = e.returncode
`);
    expect(py('r.returncode')).toBe(3);
    expect(py('r.stderr')).toBe('bad things\n');
    expect(py('raised')).toBe(3);
  });

  it('merges stderr into stdout with stderr=STDOUT', () => {
    expect(
      py(
        `subprocess.run(['fail'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout`
      )?.toString()
    ).toContain('partialbad things');
  });

  it('defers a stdin=PIPE child until communicate()', () => {
    py(`
p = subprocess.Popen(['cat'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
`);
    expect(calls).toHaveLength(0);
    // poll() never starts the child (CPython contract): still "running".
    expect(py('p.poll()')).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(py(`p.communicate('late input')[0]`)).toBe('late input');
    expect(calls).toHaveLength(1);
    expect(py('p.poll()')).toBe(0);
  });

  it('raises FileNotFoundError for a missing program (argv form only)', () => {
    py(`
try:
    subprocess.run(['nosuchtool', '-v'])
    missing = None
except FileNotFoundError as e:
    missing = e.filename
shell_code = subprocess.run('nosuchtool -v', shell=True, capture_output=True).returncode
`);
    expect(py('missing')).toBe('nosuchtool');
    expect(py('shell_code')).toBe(127);
    expect(calls[1].command).toBe('nosuchtool -v');
  });

  it('os.system returns a wait status and inherits output', () => {
    expect(py(`__import__('os').system('fail')`)).toBe(3 << 8);
  });

  it('turns a bridge failure into OSError with the matching errno', () => {
    failWith = 'ETIMEDOUT';
    py(`
import errno
try:
    subprocess.run(['echo'])
    got = None
except OSError as e:
    got = errno.errorcode[e.errno]
`);
    expect(py('got')).toBe('ETIMEDOUT');
    expect(events).toEqual(['flush', 'exec', 'invalidate']);
  });
});

describe('createPySubprocessModule', () => {
  it('rejects a malformed request without running anything', () => {
    const mod = createPySubprocessModule({
      exec,
      beforeExec: () => events.push('flush'),
      afterExec: () => events.push('invalidate'),
    });
    expect(JSON.parse(mod.run('{"command": 42}'))).toMatchObject({ error: 'EINVAL' });
    expect(JSON.parse(mod.run('not json'))).toMatchObject({ error: 'EINVAL' });
    expect(calls).toHaveLength(0);
  });
});
