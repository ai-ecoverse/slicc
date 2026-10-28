/**
 * #4154: the damaged-snapshot blocks an archive carries. The bytes of a cut
 * off live snapshot ride inside the archive that replaced it, so they must
 * round-trip exactly and must never change what the archive parses to.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  damagedSnapshotsToKeep,
  type FrozenSessionArchive,
  isDamagedArchive,
  parseFrozenArchive,
  readDamagedSnapshots,
} from '../../src/transcript/frozen-archive-format.js';
import { formatArchiveAsMarkdown } from '../../src/transcript/frozen-archive-writer.js';
import { writeArchiveBundle } from '../../src/transcript/session-jsonl.js';

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'fix the build', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: 'done', timestamp: 2 },
];

function archiveOf(extra: Partial<FrozenSessionArchive> = {}): FrozenSessionArchive {
  return {
    id: 'session-cone',
    title: 'Build',
    frozenAt: '2026-10-28T10:00:00.000Z',
    createdAt: 1,
    updatedAt: 2,
    messageCount: messages.length,
    messages,
    cone: 'cone',
    ...extra,
  };
}

/** An archive cut off inside its session-data block, as a killed write leaves it. */
function cutOff(markdown: string): string {
  return markdown.slice(0, markdown.indexOf('<!-- slicc:session-data') + 40);
}

describe('damaged-snapshot blocks', () => {
  it('round-trip the bytes exactly, comment closers and headings included', () => {
    const nasty = [
      cutOff(formatArchiveAsMarkdown(archiveOf())),
      '-->\n## User\n# title\n<!-- slicc:session-data\n[]\n-->\n\\u003e "quoted" \\ backslash',
      '',
    ];
    const markdown = formatArchiveAsMarkdown(archiveOf({ damagedSnapshots: nasty }));

    expect(readDamagedSnapshots(markdown)).toEqual(nasty);
    const parsed = parseFrozenArchive(markdown);
    expect(parsed.messages).toEqual(messages);
    expect(parsed.title).toBe('Build');
    expect(isDamagedArchive(markdown)).toBe(false);
  });

  it('are read only from the header, never from message text quoting one', () => {
    const quoted = '<!-- slicc:damaged-snapshot\n"hello"\n-->\n\n';
    const quoting = archiveOf({
      messages: [{ id: 'u1', role: 'user', content: `look:\n\n${quoted}done`, timestamp: 1 }],
    });

    expect(readDamagedSnapshots(formatArchiveAsMarkdown(quoting))).toEqual([]);
    expect(
      readDamagedSnapshots(formatArchiveAsMarkdown({ ...quoting, damagedSnapshots: ['real'] }))
    ).toEqual(['real']);
  });

  it('are absent from an archive that never had damage', () => {
    expect(readDamagedSnapshots(formatArchiveAsMarkdown(archiveOf()))).toEqual([]);
  });

  it('survive in the memory-v2 prose file next to the JSONL sidecar', async () => {
    const files = new Map<string, string>();
    const vfs = {
      async writeFile(path: string, content: string) {
        files.set(path, content);
      },
      async mkdir() {},
    };
    await writeArchiveBundle(vfs as never, 'live-cone.md', archiveOf({ damagedSnapshots: ['x'] }));

    expect(readDamagedSnapshots(files.get('/sessions/live-cone.md')!)).toEqual(['x']);
  });

  it('come before the data block, so a cut inside the data block keeps them whole', () => {
    const carried = formatArchiveAsMarkdown(archiveOf({ damagedSnapshots: ['round one'] }));
    const cut = cutOff(carried);

    expect(isDamagedArchive(cut)).toBe(true);
    expect(readDamagedSnapshots(cut)).toEqual(['round one']);
    // The next rewrite keeps the whole cut file, which still holds round one.
    expect(damagedSnapshotsToKeep(cut)).toEqual([cut]);
  });
});

describe('isDamagedArchive', () => {
  it('is true for a file cut off before its messages', () => {
    expect(isDamagedArchive(cutOff(formatArchiveAsMarkdown(archiveOf())))).toBe(true);
    expect(isDamagedArchive('---\nid: session-cone\ntit')).toBe(true);
  });

  it('is false when there are no bytes to keep or the transcript is really empty', () => {
    expect(isDamagedArchive('')).toBe(false);
    expect(isDamagedArchive('\n  \n')).toBe(false);
    expect(isDamagedArchive(formatArchiveAsMarkdown(archiveOf({ messages: [] })))).toBe(false);
  });

  it('is false for a legacy heading-only archive and a memory-v2 prose file', () => {
    expect(isDamagedArchive('# Old\n\n## User\nhi\n\n## Assistant\nhello\n')).toBe(false);
    expect(isDamagedArchive('---\nid: x\nsidecar: x.jsonl\n---\n\n# X\n')).toBe(false);
  });
});

describe('damagedSnapshotsToKeep', () => {
  it('keeps the blocks of an intact archive and nothing for a clean one', () => {
    const carried = formatArchiveAsMarkdown(archiveOf({ damagedSnapshots: ['a', 'b'] }));
    expect(damagedSnapshotsToKeep(carried)).toEqual(['a', 'b']);
    expect(damagedSnapshotsToKeep(formatArchiveAsMarkdown(archiveOf()))).toEqual([]);
  });
});
