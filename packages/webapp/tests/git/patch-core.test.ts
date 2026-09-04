import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/git/diff.js';
import {
  applyPatch,
  formatRejects,
  isCreation,
  isDeletion,
  joinLines,
  parseHeaderName,
  parseUnifiedDiff,
  reversePatch,
  splitLines,
} from '../../src/git/patch-core.js';

/** Strip the ANSI colouring `unifiedDiff` adds so the text round-trips. */
function plainDiff(oldContent: string, newContent: string, name = 'f.txt'): string {
  return unifiedDiff({ oldContent, newContent, oldName: name, newName: name, color: false });
}

describe('parseUnifiedDiff', () => {
  it('parses names, hunk positions, and both sides', () => {
    const [file] = parseUnifiedDiff(
      [
        '--- a/src/x.ts',
        '+++ b/src/x.ts',
        '@@ -2,3 +2,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '',
      ].join('\n')
    );
    expect(file.oldName).toBe('a/src/x.ts');
    expect(file.newName).toBe('b/src/x.ts');
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({
      oldStart: 2,
      newStart: 2,
      oldLines: ['one', 'two', 'three'],
      newLines: ['one', 'TWO', 'three'],
      leadingContext: 1,
      trailingContext: 1,
    });
  });

  it('skips prose, commit headers, and review chatter around the diff', () => {
    const files = parseUnifiedDiff(
      [
        'From 0123456 Mon Sep 17 00:00:00 2001',
        'Subject: [PATCH] tweak',
        '',
        'Here is the change, hope it helps.',
        '',
        'diff --git a/f.txt b/f.txt',
        'index 111..222 100644',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
        '-- ',
        '2.39.0',
      ].join('\n')
    );
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].newLines).toEqual(['b']);
  });

  it('parses several files from one patch', () => {
    const files = parseUnifiedDiff(
      [
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1 +1 @@',
        '-1',
        '+one',
        '--- a/two.txt',
        '+++ b/two.txt',
        '@@ -1 +1 @@',
        '-2',
        '+two',
        '',
      ].join('\n')
    );
    expect(files.map((file) => file.newName)).toEqual(['b/one.txt', 'b/two.txt']);
  });

  it('treats a fully blank body line as context, not as garbage', () => {
    // Mail clients and copy-paste strip the trailing space off a context line
    // that is itself empty; GNU patch tolerates it and so must we.
    const [file] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' head', '', '-x', '+y', ''].join('\n')
    );
    expect(file.hunks[0].oldLines).toEqual(['head', '', 'x']);
  });

  it('records the no-newline marker for the side it follows', () => {
    const [file] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file', ''].join(
        '\n'
      )
    );
    expect(file.hunks[0].oldNoNewlineAtEof).toBe(false);
    expect(file.hunks[0].newNoNewlineAtEof).toBe(true);
  });

  it('recognises /dev/null as creation and deletion', () => {
    const [created] = parseUnifiedDiff(
      ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hello', ''].join('\n')
    );
    expect(isCreation(created)).toBe(true);
    const [deleted] = parseUnifiedDiff(
      ['--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', ''].join('\n')
    );
    expect(isDeletion(deleted)).toBe(true);
  });

  it('drops the timestamp diff appends after a tab', () => {
    expect(parseHeaderName('a/f.txt\t2026-09-04 10:00:00.000 +0200')).toBe('a/f.txt');
  });

  it('drops a space-separated timestamp but keeps spaces inside a name', () => {
    expect(parseHeaderName('a/f.txt 2026-09-04 10:00:00')).toBe('a/f.txt');
    expect(parseHeaderName('my notes.txt')).toBe('my notes.txt');
  });

  it('returns nothing for input that holds no hunks', () => {
    expect(parseUnifiedDiff('just some prose\nwith no diff in it\n')).toEqual([]);
  });
});

describe('splitLines / joinLines', () => {
  it('round-trips text with and without a trailing newline', () => {
    for (const text of ['', 'a\n', 'a', 'a\nb\n', 'a\nb', '\n']) {
      expect(joinLines(splitLines(text))).toBe(text);
    }
  });
});

describe('applyPatch', () => {
  const source = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n') + '\n';

  it('applies a diff produced by unifiedDiff, reproducing the new text', () => {
    const updated = source.replace('gamma', 'GAMMA');
    const [patch] = parseUnifiedDiff(plainDiff(source, updated));
    expect(applyPatch(source, patch).text).toBe(updated);
  });

  it('finds a hunk that has drifted and reports the offset', () => {
    const updated = source.replace('gamma', 'GAMMA');
    const [patch] = parseUnifiedDiff(plainDiff(source, updated));
    const drifted = `zero\none\n${source}`;
    const result = applyPatch(drifted, patch);
    expect(result.text).toBe(`zero\none\n${updated}`);
    expect(result.outcomes[0]).toMatchObject({ applied: true, offset: 2, fuzz: 0 });
  });

  it('ignores context lines to place a hunk whose surroundings moved', () => {
    const updated = source.replace('gamma', 'GAMMA');
    const [patch] = parseUnifiedDiff(plainDiff(source, updated));
    const edited = source.replace('alpha', 'ALPHA').replace('epsilon', 'EPSILON');
    const result = applyPatch(edited, patch);
    expect(result.text).toContain('GAMMA');
    expect(result.outcomes[0]).toMatchObject({ applied: true, fuzz: 1 });
  });

  it('never fuzzes away a removed line, so a hunk on missing text is rejected', () => {
    const [patch] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' alpha', '-nowhere', '+here', ' gamma', ''].join(
        '\n'
      )
    );
    const result = applyPatch(source, patch, { fuzz: 3 });
    expect(result.outcomes[0].applied).toBe(false);
    expect(result.text).toBe(source);
    expect(result.rejected).toHaveLength(1);
  });

  it('applies the hunks it can and rejects only the ones it cannot', () => {
    const [patch] = parseUnifiedDiff(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,2 @@',
        '-alpha',
        '+ALPHA',
        ' beta',
        '@@ -4,2 +4,2 @@',
        '-nope',
        '+NOPE',
        ' nor this',
        '',
      ].join('\n')
    );
    const result = applyPatch(source, patch);
    expect(result.text.startsWith('ALPHA\n')).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.applied)).toEqual([true, false]);
    expect(formatRejects(patch, result.rejected)).toContain('+NOPE');
  });

  it('creates a file from a /dev/null patch', () => {
    const [patch] = parseUnifiedDiff(
      ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n')
    );
    expect(applyPatch('', patch).text).toBe('one\ntwo\n');
  });

  it('empties a file a deletion patch removes', () => {
    const [patch] = parseUnifiedDiff(
      ['--- a/old.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n')
    );
    expect(applyPatch('one\ntwo\n', patch).text).toBe('');
  });

  it('honours the no-newline marker on the new side', () => {
    const [patch] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file', ''].join(
        '\n'
      )
    );
    expect(applyPatch('a\n', patch).text).toBe('b');
  });

  it('restores the trailing newline when the patch adds one back', () => {
    const [patch] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-b', '\\ No newline at end of file', '+b', ''].join(
        '\n'
      )
    );
    expect(applyPatch('b', patch).text).toBe('b\n');
  });

  it('applies several hunks in one file, tracking the drift between them', () => {
    const updated = source.replace('alpha', 'a\nlpha').replace('epsilon', 'EPSILON');
    const [patch] = parseUnifiedDiff(plainDiff(source, updated));
    expect(applyPatch(source, patch).text).toBe(updated);
  });
});

describe('reversePatch', () => {
  it('undoes an applied patch', () => {
    const source = 'one\ntwo\nthree\n';
    const updated = 'one\nTWO\nthree\n';
    const [patch] = parseUnifiedDiff(plainDiff(source, updated));
    const forward = applyPatch(source, patch).text;
    expect(forward).toBe(updated);
    expect(applyPatch(forward, reversePatch(patch)).text).toBe(source);
  });

  it('swaps the names and the hunk body in the reject text', () => {
    const [patch] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    );
    const reversed = reversePatch(patch);
    expect(reversed.oldName).toBe('b/f');
    expect(reversed.newName).toBe('a/f');
    expect(reversed.hunks[0].raw).toEqual(['@@ -1,1 +1,1 @@', '+a', '-b']);
  });

  it('carries the no-newline marker to the other side', () => {
    const [patch] = parseUnifiedDiff(
      ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file', ''].join(
        '\n'
      )
    );
    const reversed = reversePatch(patch);
    expect(reversed.hunks[0].oldNoNewlineAtEof).toBe(true);
    expect(reversed.hunks[0].newNoNewlineAtEof).toBe(false);
    expect(applyPatch('b', reversed).text).toBe('a\n');
  });
});
