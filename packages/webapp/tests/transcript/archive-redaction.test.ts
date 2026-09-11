/**
 * Archive-at-rest credential redaction (Track C, P0c): the scan itself,
 * and each serializer chokepoint that must persist clean bytes — the
 * markdown archive, the JSONL sidecar, and the spawned-agent archive.
 */
import { describe, expect, it } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import { serializeAgentSessionArchive } from '../../src/scoops/agent-session-archive.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  newAtRestState,
  redactArchiveText,
  redactChatMessagesAtRest,
} from '../../src/transcript/archive-redaction.js';
import { parseFrozenArchive } from '../../src/transcript/frozen-archive-format.js';
import { formatArchiveAsMarkdown } from '../../src/transcript/frozen-archive-writer.js';
import { type SessionJsonlVfs, writeSessionJsonl } from '../../src/transcript/session-jsonl.js';

const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnop';
const JWT = 'eyJhbGciOi.eyJzdWIiOjE.c2lnbmF0dXJl';

function jsonlVfs(): SessionJsonlVfs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return files.get(path)!;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async rm(path: string): Promise<void> {
      files.delete(path);
    },
  };
}

function archiveWith(messages: ChatMessage[], title = 'A session') {
  return {
    id: 'sid',
    title,
    frozenAt: '2026-09-11T10:00:00.000Z',
    createdAt: 1,
    updatedAt: 2,
    messageCount: messages.length,
    messages,
  };
}

describe('redactArchiveText', () => {
  it('scrubs structural key material', () => {
    const state = newAtRestState();
    const out = redactArchiveText(
      `key ${ANTHROPIC_KEY} and jwt ${JWT} and Bearer abc123token`,
      state
    );
    expect(out).not.toContain(ANTHROPIC_KEY);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('abc123token');
    expect(out).toContain('⟦REDACTED:api-key:ar');
    expect(out).toContain('⟦REDACTED:jwt:ar');
    expect(out).toContain('⟦REDACTED:bearer-token:ar');
  });

  it('leaves keyword assignments alone at rest — code discussion survives', () => {
    const state = newAtRestState();
    const text = 'set token = getToken() and password: fetchFromVault()';
    expect(redactArchiveText(text, state)).toBe(text);
  });

  it('is idempotent: existing markers are not re-wrapped', () => {
    const once = redactArchiveText(`key ${ANTHROPIC_KEY}`, newAtRestState());
    expect(redactArchiveText(once, newAtRestState())).toBe(once);
  });

  it('numbers markers continuously across one archive via shared state', () => {
    const state = newAtRestState();
    const first = redactArchiveText(ANTHROPIC_KEY, state);
    const second = redactArchiveText(JWT, state);
    expect(first).toContain(':ar1⟧');
    expect(second).toContain(':ar2⟧');
  });
});

describe('redactChatMessagesAtRest', () => {
  it('returns the same reference when no message carries a secret', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'fix the build', timestamp: 1 },
    ];
    expect(redactChatMessagesAtRest(messages)).toBe(messages);
  });

  it('scrubs tool-call input and result leaves, not just message content', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: 'ran it',
        timestamp: 2,
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            input: { cmd: `curl -H "Authorization: Bearer ${JWT}"` },
            result: `saved ${ANTHROPIC_KEY}`,
          },
        ],
      },
    ];
    const out = redactChatMessagesAtRest(messages);
    const dumped = JSON.stringify(out);
    expect(dumped).not.toContain(JWT);
    expect(dumped).not.toContain(ANTHROPIC_KEY);
    expect(out[0]!.content).toBe('ran it');
  });
});

describe('formatArchiveAsMarkdown at-rest redaction', () => {
  it('persists no key material in the JSON block, the body, or the title', () => {
    const markdown = formatArchiveAsMarkdown(
      archiveWith(
        [{ id: 'u1', role: 'user', content: `here is my key: ${ANTHROPIC_KEY}`, timestamp: 1 }],
        `Paste of ${ANTHROPIC_KEY}`
      )
    );
    expect(markdown).not.toContain(ANTHROPIC_KEY);
    expect(markdown).toContain('⟦REDACTED:api-key:');
  });

  it('still round-trips through parseFrozenArchive after redaction', () => {
    const markdown = formatArchiveAsMarkdown(
      archiveWith([{ id: 'u1', role: 'user', content: `token time "${JWT}" done`, timestamp: 1 }])
    );
    const parsed = parseFrozenArchive(markdown);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]!.content).toContain('⟦REDACTED:jwt:');
    expect(parsed.messages[0]!.content).not.toContain(JWT);
  });
});

describe('writeSessionJsonl at-rest redaction', () => {
  it('persists a scrubbed sidecar', async () => {
    const vfs = jsonlVfs();
    await writeSessionJsonl(vfs, 'a.md', [
      { id: 'u1', role: 'user', content: `key ${ANTHROPIC_KEY}`, timestamp: 1 },
    ]);
    const sidecar = vfs.files.get('/sessions/a.jsonl')!;
    expect(sidecar).not.toContain(ANTHROPIC_KEY);
    expect(sidecar).toContain('⟦REDACTED:api-key:');
    // Still valid JSONL after replacement inside a JSON string value.
    expect(() => JSON.parse(sidecar.trim())).not.toThrow();
  });
});

describe('serializeAgentSessionArchive at-rest redaction', () => {
  it('scrubs the prompt and rendered messages', () => {
    const markdown = serializeAgentSessionArchive({
      name: 'zesty-custard',
      jid: 'agent_zesty_custard',
      prompt: `use ${ANTHROPIC_KEY} for the call`,
      exitCode: 0,
      messages: [],
      timestamp: '2026-09-11T10-00-00',
    });
    expect(markdown).not.toContain(ANTHROPIC_KEY);
    expect(markdown).toContain('⟦REDACTED:api-key:');
  });
});
