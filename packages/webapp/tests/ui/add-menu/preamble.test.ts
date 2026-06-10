import { describe, expect, it } from 'vitest';
import type { AddItem } from '../../../src/ui/add-menu/add-item.js';
import { compileContextPreamble } from '../../../src/ui/add-menu/preamble.js';

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
