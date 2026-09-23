import { resolve } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { PYTHON_RUNNER } from '../../../src/kernel/realm/py-realm-shared.js';

const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide');

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  pyodide.FS.mkdirTree('/app/tools');
  pyodide.FS.writeFile('/app/tools/__init__.py', 'NAME = "tools"\n');
  pyodide.FS.mkdirTree('/work');
  pyodide.FS.chdir('/work');
}, 60_000);

function run(code: string, filename: string, argv: string[]) {
  pyodide.globals.set('__slicc_code', code);
  pyodide.globals.set('__slicc_filename', filename);

  pyodide.globals.set('__slicc_argv', argv);
  pyodide.runPython('import sys; __saved_path = list(sys.path)');
  pyodide.runPython(PYTHON_RUNNER);
  const result = {
    exit: pyodide.globals.get('__slicc_exit_code') as number,
    path0: pyodide.runPython('sys.path[0]') as string,
    cwdOnPath: pyodide.runPython('"" in sys.path') as boolean,
    argvTail: pyodide.runPython('repr(sys.argv[1:])') as string,
  };
  pyodide.runPython('sys.path[:] = __saved_path; sys.modules.pop("tools", None)');
  return result;
}

describe('PYTHON_RUNNER sys.argv', () => {
  it('is a real list of str, so slices keep every argument', () => {
    const code =
      'import sys\nassert type(sys.argv) is list and all(type(a) is str for a in sys.argv)\n';
    const { exit, argvTail } = run(code, '/app/main.py', ['/app/main.py', 'hello.c', '-o', 'x.js']);
    expect(exit).toBe(0);
    expect(argvTail).toBe("['hello.c', '-o', 'x.js']");
  });
});

describe('PYTHON_RUNNER sys.path', () => {
  it("puts a script's directory first so its sibling package imports", () => {
    const code = 'from tools import NAME\nassert NAME == "tools"\n';
    const { exit, path0, cwdOnPath } = run(code, '/app/main.py', ['/app/main.py']);
    expect(exit).toBe(0);
    expect(path0).toBe('/app');

    expect(cwdOnPath).toBe(false);
  });

  it('resolves a relative script path against the cwd', () => {
    const { path0 } = run('pass', '../app/main.py', ['../app/main.py']);
    expect(path0).toBe('/app');
  });

  it("puts '' (the cwd) first for -c and stdin", () => {
    expect(run('pass', '-c', ['-c']).path0).toBe('');
    expect(run('pass', '<stdin>', ['<stdin>']).path0).toBe('');
  });
});
