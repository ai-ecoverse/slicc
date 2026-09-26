import { resolve } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { flushPythonStreams, textSink } from '../../../src/kernel/realm/py-realm-shared.js';

const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide');

let pyodide: PyodideInterface;

beforeAll(async () => {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
}, 60_000);

function capture(code: string): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  pyodide.setStdout(textSink(out));
  pyodide.setStderr(textSink(err));
  pyodide.runPython(code);
  flushPythonStreams(pyodide);
  return { out: out.join(''), err: err.join('') };
}

describe('Python realm output', () => {
  it('keeps an unterminated last line', () => {
    expect(capture('import sys; sys.stdout.write("3;14;2")').out).toBe('3;14;2');
    expect(capture('print("a", end="")').out).toBe('a');
  });

  it('adds no newline and keeps line breaks as written', () => {
    expect(capture('print("x"); print("y", end="")').out).toBe('x\ny');
    expect(capture('import sys; sys.stderr.write("e1\\ne2")').err).toBe('e1\ne2');
  });

  it('decodes multi-byte UTF-8 split across writes', () => {
    expect(
      capture(
        'import sys; b = "é€".encode(); sys.stdout.buffer.write(b[:1]); sys.stdout.buffer.write(b[1:])'
      ).out
    ).toBe('é€');
  });

  it('preserves a leading UTF-8 BOM', () => {
    const chunks: string[] = [];
    const sink = textSink(chunks);
    sink.write(new TextEncoder().encode('\ufefftext\n'));
    expect(chunks.join('')).toBe('\ufefftext\n');

    expect(capture('import sys; sys.stdout.write("\\ufefftext\\n")').out).toBe('\ufefftext\n');
  });
});
