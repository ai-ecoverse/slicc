import { describe, it, expect } from 'vitest';
import { unifiedDiff, diffStat } from './diff.js';

describe('unifiedDiff', () => {
  it('returns empty string for identical content', () => {
    const result = unifiedDiff({
      oldContent: 'hello\nworld\n',
      newContent: 'hello\nworld\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    expect(result).toBe('');
  });

  it('shows added lines', () => {
    const result = unifiedDiff({
      oldContent: 'line1\nline2\n',
      newContent: 'line1\nline2\nline3\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    expect(result).toContain('+line3');
    expect(result).toContain('--- a/file.txt');
    expect(result).toContain('+++ b/file.txt');
    expect(result).toContain('@@');
  });

  it('shows deleted lines', () => {
    const result = unifiedDiff({
      oldContent: 'line1\nline2\nline3\n',
      newContent: 'line1\nline3\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    expect(result).toContain('-line2');
  });

  it('shows modified lines as delete+insert', () => {
    const result = unifiedDiff({
      oldContent: 'hello world\n',
      newContent: 'hello universe\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    expect(result).toContain('-hello world');
    expect(result).toContain('+hello universe');
  });

  it('handles new file (empty old content)', () => {
    const result = unifiedDiff({
      oldContent: '',
      newContent: 'new content\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    expect(result).toContain('+new content');
  });

  it('handles deleted file (empty new content)', () => {
    const result = unifiedDiff({
      oldContent: 'old content\n',
      newContent: '',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    expect(result).toContain('-old content');
  });

  it('includes context lines around changes', () => {
    const result = unifiedDiff({
      oldContent: 'a\nb\nc\nd\ne\nf\ng\n',
      newContent: 'a\nb\nc\nX\ne\nf\ng\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    // Context should include lines around the change
    expect(result).toContain(' a');
    expect(result).toContain(' b');
    expect(result).toContain(' c');
    expect(result).toContain('-d');
    expect(result).toContain('+X');
    expect(result).toContain(' e');
    expect(result).toContain(' f');
    expect(result).toContain(' g');
  });

  it('includes color codes when color is enabled', () => {
    const result = unifiedDiff({
      oldContent: 'old\n',
      newContent: 'new\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: true,
    });
    expect(result).toContain('\x1b[31m'); // red for deletions
    expect(result).toContain('\x1b[32m'); // green for insertions
    expect(result).toContain('\x1b[36m'); // cyan for @@ headers
  });

  it('produces correct hunk header format', () => {
    const result = unifiedDiff({
      oldContent: 'line1\nline2\n',
      newContent: 'line1\nmodified\n',
      oldName: 'file.txt',
      newName: 'file.txt',
      color: false,
    });
    // Should have @@ -start,count +start,count @@ format
    expect(result).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });
});

describe('diffStat', () => {
  it('returns zero for identical content', () => {
    const result = diffStat('hello\n', 'hello\n');
    expect(result).toEqual({ insertions: 0, deletions: 0 });
  });

  it('counts insertions', () => {
    const result = diffStat('line1\n', 'line1\nline2\n');
    expect(result.insertions).toBeGreaterThan(0);
    expect(result.deletions).toBe(0);
  });

  it('counts deletions', () => {
    const result = diffStat('line1\nline2\n', 'line1\n');
    expect(result.deletions).toBeGreaterThan(0);
    expect(result.insertions).toBe(0);
  });

  it('counts both insertions and deletions', () => {
    const result = diffStat('old line\n', 'new line\n');
    expect(result.insertions).toBeGreaterThan(0);
    expect(result.deletions).toBeGreaterThan(0);
  });
});
