import { describe, expect, it } from 'vitest';
import {
  extractSkillDescription,
  parseSkillFrontmatter,
  parseSkillFrontmatterFields,
  parseYamlStringValue,
} from '../../src/skills/frontmatter.js';

describe('parseSkillFrontmatter', () => {
  it('parses a single-line description unchanged', () => {
    const { metadata, body } = parseSkillFrontmatter(
      '---\nname: browser\ndescription: Browse the web\n---\n# Body\n'
    );
    expect(metadata).toEqual({ name: 'browser', description: 'Browse the web' });
    expect(body).toBe('# Body\n');
  });

  it('parses a literal block scalar (|) keeping newlines', () => {
    const { metadata } = parseSkillFrontmatter(`---
name: literal
description: |
  Line one
  Line two
---
Body
`);
    expect(metadata.description).toBe('Line one\nLine two');
    expect(metadata.name).toBe('literal');
  });

  it('parses a folded block scalar (>) joining lines with spaces', () => {
    const { metadata } = parseSkillFrontmatter(`---
name: folded
description: >
  A multi-line description
  that spans several lines.
---
Body
`);
    expect(metadata.description).toBe('A multi-line description that spans several lines.');
  });

  it('honours chomping indicators on block scalars (|- and >+)', () => {
    const literal = parseSkillFrontmatter(`---
name: strip
description: |-
  Keep newlines
  without trailing pad
---
`);
    expect(literal.metadata.description).toBe('Keep newlines\nwithout trailing pad');

    const folded = parseSkillFrontmatter(`---
name: keep
description: >+
  Folded with
  chomp keep
---
`);
    expect(folded.metadata.description).toBe('Folded with chomp keep');
  });

  it('does not leave bare | or > as the description', () => {
    const barePipe = parseSkillFrontmatter('---\nname: x\ndescription: |\n  Real text\n---\n');
    const bareFold = parseSkillFrontmatter('---\nname: y\ndescription: >\n  Real text\n---\n');
    expect(barePipe.metadata.description).not.toBe('|');
    expect(barePipe.metadata.description).toBe('Real text');
    expect(bareFold.metadata.description).not.toBe('>');
    expect(bareFold.metadata.description).toBe('Real text');
  });

  it('unquotes single- and double-quoted scalars', () => {
    expect(
      parseSkillFrontmatter(`---\nname: q\ndescription: 'Skill for X: does Y'\n---\n`).metadata
        .description
    ).toBe('Skill for X: does Y');
    expect(
      parseSkillFrontmatter(`---\nname: e\ndescription: "Nested \\"quote\\""\n---\n`).metadata
        .description
    ).toBe('Nested "quote"');
  });

  it('parses allowed-tools, layout, and theme string fields', () => {
    const { metadata } = parseSkillFrontmatter(`---
name: rich
description: |
  Does things
allowed-tools: bash, read_file
layout: coding
theme: dark
---
`);
    expect(metadata).toEqual({
      name: 'rich',
      description: 'Does things',
      allowedTools: ['bash', 'read_file'],
      layout: 'coding',
      theme: 'dark',
    });
  });

  it('returns the whole content as body when frontmatter is absent', () => {
    const { metadata, body } = parseSkillFrontmatter('# Just a body\n');
    expect(metadata).toEqual({});
    expect(body).toBe('# Just a body\n');
  });

  it('tolerates BOM, CRLF, and leading blank lines', () => {
    const content =
      '\uFEFF\r\n---\r\nname: windows\r\ndescription: |\r\n  Authored on Windows.\r\n---\r\n# Body\r\n';
    const { metadata, body } = parseSkillFrontmatter(content);
    expect(metadata.name).toBe('windows');
    expect(metadata.description).toBe('Authored on Windows.');
    expect(body).toBe('# Body\n');
  });
});

describe('extractSkillDescription', () => {
  it('returns null when description is missing', () => {
    expect(extractSkillDescription('---\nname: only\n---\n')).toBeNull();
    expect(extractSkillDescription('# no frontmatter')).toBeNull();
  });

  it('returns the block-scalar description', () => {
    expect(extractSkillDescription('---\nname: x\ndescription: |\n  Hello agents\n---\n')).toBe(
      'Hello agents'
    );
  });
});

describe('parseSkillFrontmatterFields / parseYamlStringValue', () => {
  it('parses a yaml block in isolation', () => {
    expect(parseSkillFrontmatterFields('name: solo\ndescription: >\n  Folded\n  here')).toEqual({
      name: 'solo',
      description: 'Folded here',
    });
  });

  it('advances past block-scalar continuation lines', () => {
    const lines = ['description: |', '  a', '  b', 'name: after'];
    const { value, lastIndex } = parseYamlStringValue('|', lines, 1);
    expect(value).toBe('a\nb');
    expect(lastIndex).toBe(2);
  });
});
