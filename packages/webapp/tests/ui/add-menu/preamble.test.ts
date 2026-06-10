import { describe, expect, it } from 'vitest';
import type { AddItem } from '../../../src/ui/add-menu/add-item.js';
import { compileContextPreamble, stripContextPreamble } from '../../../src/ui/add-menu/preamble.js';

describe('compileContextPreamble', () => {
  it('returns empty string for no references', () => {
    expect(compileContextPreamble([])).toBe('');
  });

  it('emits one line per reference under a [context] header', () => {
    const refs: AddItem[] = [
      { kind: 'file', label: 'CLAUDE.md', locator: '/workspace/CLAUDE.md' },
      { kind: 'folder', label: 'src', locator: '/workspace/src' },
      { kind: 'skill', label: 'sprinkles', locator: 'sprinkles' },
      { kind: 'scoop', label: 'my-scoop', locator: 'jid-123' },
    ];
    expect(compileContextPreamble(refs)).toBe(
      [
        '[context]',
        '- file: /workspace/CLAUDE.md (CLAUDE.md)',
        '- folder: /workspace/src (src)',
        '- skill: sprinkles',
        '- scoop: jid-123 (my-scoop)',
      ].join('\n')
    );
  });

  it('appends label in parens when it differs from the locator', () => {
    const refs: AddItem[] = [
      { kind: 'session', label: 'Fix the build', locator: '/sessions/2026-06-01-foo.md' },
    ];
    expect(compileContextPreamble(refs)).toBe(
      '[context]\n- session: /sessions/2026-06-01-foo.md (Fix the build)'
    );
  });
});

describe('stripContextPreamble', () => {
  it('removes a leading [context] block from agent-sourced user text', () => {
    const raw = '[context]\n- file: /workspace/CLAUDE.md (CLAUDE.md)\n\nexplain this';
    expect(stripContextPreamble(raw)).toBe('explain this');
  });
  it('leaves normal text untouched', () => {
    expect(stripContextPreamble('just a question')).toBe('just a question');
  });
  it('returns empty string when the text is only a preamble', () => {
    expect(stripContextPreamble('[context]\n- skill: sprinkles')).toBe('');
  });
  it('only strips a [context] block at the very start', () => {
    const raw = 'hello [context]\n- skill: x\n\nworld';
    expect(stripContextPreamble(raw)).toBe(raw);
  });
});
