import { describe, expect, it } from 'vitest';
import {
  biomeBinCandidates,
  formatGithubAnnotation,
  makeErrorAnnotation,
  parseGithubAnnotation,
  remapGithubOutput,
  shiftAnnotationToRealFile,
} from './lib.mjs';

const LINE =
  '::error title=lint/suspicious/noDoubleEquals,file=tmp.js,line=3,endLine=3,col=7,endColumn=9::Using == may be unsafe.';

describe('parseGithubAnnotation', () => {
  it('parses level, ordered fields, and message', () => {
    const parsed = parseGithubAnnotation(LINE);
    expect(parsed.level).toBe('error');
    expect(parsed.fields).toEqual({
      title: 'lint/suspicious/noDoubleEquals',
      file: 'tmp.js',
      line: '3',
      endLine: '3',
      col: '7',
      endColumn: '9',
    });
    expect(parsed.message).toBe('Using == may be unsafe.');
  });

  it('returns null for non-annotation lines', () => {
    expect(parseGithubAnnotation('check ━━━ summary')).toBeNull();
    expect(parseGithubAnnotation('')).toBeNull();
  });

  it('round-trips through formatGithubAnnotation', () => {
    expect(formatGithubAnnotation(parseGithubAnnotation(LINE))).toBe(LINE);
  });
});

describe('shiftAnnotationToRealFile', () => {
  it('subtracts the line delta and rewrites the file, leaving columns intact', () => {
    const shifted = shiftAnnotationToRealFile(parseGithubAnnotation(LINE), 'src/tool.jsh', 1);
    expect(shifted.fields.file).toBe('src/tool.jsh');
    expect(shifted.fields.line).toBe('2');
    expect(shifted.fields.endLine).toBe('2');
    expect(shifted.fields.col).toBe('7');
    expect(shifted.fields.endColumn).toBe('9');
  });

  it('clamps shifted lines to a minimum of 1', () => {
    const first = parseGithubAnnotation(
      '::error title=x,file=t.js,line=1,endLine=1,col=1,endColumn=1::m'
    );
    const shifted = shiftAnnotationToRealFile(first, 'real.jsh', 1);
    expect(shifted.fields.line).toBe('1');
  });
});

describe('remapGithubOutput', () => {
  it('shifts + rewrites annotations, passes other lines through, and counts', () => {
    const stdout = [
      LINE,
      '::warning title=lint/style/x,file=tmp.js,line=5,endLine=5,col=1,endColumn=2::careful',
      'check ━━━ human summary line',
    ].join('\n');
    const { lines, errorCount, warningCount } = remapGithubOutput(stdout, 'src/tool.jsh', 1);
    expect(errorCount).toBe(1);
    expect(warningCount).toBe(1);
    expect(lines[0]).toContain('file=src/tool.jsh');
    expect(lines[0]).toContain('line=2');
    expect(lines[1]).toContain('line=4');
    expect(lines[2]).toBe('check ━━━ human summary line');
  });

  it('a zero delta only rewrites the path (pass-through files)', () => {
    const { lines } = remapGithubOutput(LINE, 'pkg/a.js', 0);
    expect(lines[0]).toContain('file=pkg/a.js');
    expect(lines[0]).toContain('line=3');
  });
});

describe('makeErrorAnnotation', () => {
  it('builds a formattable error annotation for a real file', () => {
    const line = formatGithubAnnotation(makeErrorAnnotation('a.jsh', 'not formatted'));
    expect(line).toBe(
      '::error title=format,file=a.jsh,line=1,endLine=1,col=1,endColumn=1::not formatted'
    );
  });
});

describe('biomeBinCandidates', () => {
  it('walks up from each start dir emitting node_modules/.bin/biome', () => {
    const candidates = biomeBinCandidates(['/a/b/c']);
    expect(candidates).toContain('/a/b/c/node_modules/.bin/biome');
    expect(candidates).toContain('/a/b/node_modules/.bin/biome');
    expect(candidates).toContain('/node_modules/.bin/biome');
  });

  it('deduplicates overlapping ancestor paths across start dirs', () => {
    const candidates = biomeBinCandidates(['/a/b', '/a/c']);
    const root = candidates.filter((p) => p === '/a/node_modules/.bin/biome');
    expect(root).toHaveLength(1);
  });
});
