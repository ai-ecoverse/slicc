import { describe, expect, it } from 'vitest';
import {
  findDroppedSkillFile,
  findDroppedSkillTransferFile,
  isSkillArchiveName,
} from './skill-drop.js';

describe('skill-drop helpers', () => {
  it('matches .skill archives case-insensitively', () => {
    expect(isSkillArchiveName('hello.skill')).toBe(true);
    expect(isSkillArchiveName('HELLO.SKILL')).toBe(true);
    expect(isSkillArchiveName('hello.zip')).toBe(false);
  });

  it('returns the first dropped .skill file', () => {
    const file = findDroppedSkillFile([
      { name: 'notes.txt' },
      { name: 'hello.skill' },
      { name: 'other.skill' },
    ]);

    expect(file?.name).toBe('hello.skill');
  });

  it('returns null when no supported archive is present', () => {
    expect(findDroppedSkillFile([{ name: 'notes.txt' }, { name: 'demo.zip' }])).toBeNull();
  });

  it('detects a .skill file from dataTransfer items when files is empty', () => {
    const file = findDroppedSkillTransferFile({
      files: [],
      items: [
        {
          kind: 'file',
          getAsFile: () => ({ name: 'dragged.skill' }),
        },
      ],
    });

    expect(file?.name).toBe('dragged.skill');
  });

  it('ignores non-file items and unsupported file names in transfer items', () => {
    expect(
      findDroppedSkillTransferFile({
        items: [
          { kind: 'string', getAsFile: () => ({ name: 'ignored.skill' }) },
          { kind: 'file', getAsFile: () => ({ name: 'notes.txt' }) },
        ],
      }),
    ).toBeNull();
  });
});