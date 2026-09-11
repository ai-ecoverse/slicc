/**
 * Session JSONL sidecar + keyword search index (Memory v2).
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { initFeatureFlags } from '../../src/core/feature-flags.js';
import { VirtualFS } from '../../src/fs/index.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import { parseFrozenArchive, SESSIONS_DIR } from '../../src/transcript/frozen-archive-format.js';
import { formatArchiveAsMarkdown } from '../../src/transcript/frozen-archive-writer.js';
import {
  chatMessagesToJsonl,
  jsonlToChatMessages,
  loadFrozenArchive,
  sidecarFilenameForArchive,
  writeArchiveBundle,
} from '../../src/transcript/session-jsonl.js';
import {
  classifyEchoKind,
  docsFromArchive,
  makeHitId,
  parseHitId,
  porterStem,
  readSessionHit,
  rebuildSessionSearchIndex,
  SESSION_INDEX_BODY_BYTE_CAP,
  SESSION_READ_BYTE_CAP,
  searchSessions,
  truncateUtf8,
} from '../../src/transcript/session-search-index.js';

function msg(
  role: ChatMessage['role'],
  content: string,
  id: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return { id, role, content, timestamp: 1, ...extra };
}

describe('session JSONL sidecar', () => {
  it('round-trips chat messages through pi-ai-shaped JSONL', () => {
    const messages: ChatMessage[] = [
      msg('user', 'What is the OpTel budget?', 'u1', {
        attachments: [
          {
            id: 'att-1',
            name: 'budget.md',
            mimeType: 'text/markdown',
            size: 12,
            kind: 'text',
            path: '/tmp/attachment-budget.md',
          },
        ],
      }),
      msg('assistant', 'The OpTel budget is $12k.', 'a1', {
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            input: { command: 'cat /tmp/budget.md' },
            result: 'budget: 12000',
          },
        ],
      }),
    ];
    const jsonl = chatMessagesToJsonl(messages);
    expect(jsonl.split('\n').filter(Boolean)).toHaveLength(3); // user, assistant, toolResult
    expect(jsonl).toContain('"role":"toolResult"');
    expect(jsonl).toContain('"type":"toolCall"');
    expect(jsonl).toContain('"path":"/tmp/attachment-budget.md"');
    const back = jsonlToChatMessages(jsonl);
    expect(back).toHaveLength(2);
    expect(back[0].content).toBe('What is the OpTel budget?');
    expect(back[0].attachments?.[0].path).toBe('/tmp/attachment-budget.md');
    expect(back[1].toolCalls?.[0].result).toBe('budget: 12000');
  });

  it('writes prose-only markdown + JSONL when sidecar mode is on', async () => {
    let db = 0;
    const vfs = await VirtualFS.create({ dbName: `jsonl-${db++}`, wipe: true });
    await vfs.mkdir(SESSIONS_DIR, { recursive: true });
    const archive = {
      id: 'sid-1',
      title: 'OpTel budget',
      frozenAt: '2026-09-10T12:00:00.000Z',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      messages: [
        msg('user', 'What is the OpTel budget?', 'u1'),
        msg('assistant', 'The OpTel budget is $12k.', 'a1'),
      ],
    };
    const filename = '2026-09-10T12-00-00-000Z-optel.md';
    await writeArchiveBundle(vfs, filename, archive);

    const md = (await vfs.readFile(`${SESSIONS_DIR}/${filename}`, {
      encoding: 'utf-8',
    })) as string;
    expect(md).toContain('sidecar: 2026-09-10T12-00-00-000Z-optel.jsonl');
    expect(md).not.toContain('<!-- slicc:session-data');
    expect(md).toContain('The OpTel budget is $12k.');

    const syncParsed = parseFrozenArchive(md);
    expect(syncParsed.messages).toHaveLength(0);
    expect(syncParsed.sidecar).toBe(sidecarFilenameForArchive(filename));

    const loaded = await loadFrozenArchive(vfs, md, filename);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].content).toContain('OpTel budget');
  });

  it('keeps embedded session-data when sidecar mode is off', () => {
    const markdown = formatArchiveAsMarkdown({
      id: 'sid-2',
      title: 't',
      frozenAt: 'now',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      messages: [msg('user', 'hello', 'u1')],
    });
    expect(markdown).toContain('<!-- slicc:session-data');
    expect(parseFrozenArchive(markdown).messages[0].content).toBe('hello');
  });
});

describe('session search ranking', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    initFeatureFlags('standalone', { 'memory-v2': 'on' });
    vfs = await VirtualFS.create({ dbName: `search-${dbCounter++}`, wipe: true });
    await vfs.mkdir(SESSIONS_DIR, { recursive: true });
  });

  it('stems English terms with a Porter-style stemmer', () => {
    expect(porterStem('compactions')).toBe(porterStem('compaction'));
    expect(porterStem('running')).toMatch(/^run/);
  });

  it('classifies summaries and search echoes below original content', () => {
    expect(classifyEchoKind(msg('user', 'real fact about OpTel', 'u1'))).toBe('original');
    expect(
      classifyEchoKind(msg('user', '<context-summary>\nprior turns\n</context-summary>', 'u2'))
    ).toBe('summary');
    expect(
      classifyEchoKind({
        id: 'c1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        compaction: { trigger: 'threshold', state: 'summarized' },
      })
    ).toBe('summary');
    expect(
      classifyEchoKind(msg('assistant', '# session search: optel (2 hits)\nid=sess/x/msg/y', 'a1'))
    ).toBe('echo');
  });

  it('answers a realistic past-session question in ≤3 bounded tool calls', async () => {
    // Fixture: primary fact buried under a compaction summary + a prior search echo.
    const sessionId = 'sess-optel-2026';
    const filename = '2026-09-09T10-00-00-000Z-optel-planning.md';
    const messages: ChatMessage[] = [
      msg('user', 'We need to plan the OpTel rollout.', 'u0'),
      msg(
        'assistant',
        'Agreed. The approved OpTel annual budget is twelve thousand dollars ($12,000).',
        'a0'
      ),
      msg(
        'user',
        '<context-summary>\nEarlier we discussed budgets and OpTel vaguely.\n</context-summary>\nThe full transcript of the conversation before this compaction is saved at /sessions/live-cone-x.md — read it when the summary is not enough.',
        'u1'
      ),
      msg('assistant', '# session search: budget (1 hits)\nid=sess/other/msg/z\n  …budget…', 'a1'),
      msg('user', 'Remind me of the OpTel number later.', 'u2'),
    ];
    await writeArchiveBundle(vfs, filename, {
      id: sessionId,
      title: 'OpTel planning',
      frozenAt: '2026-09-09T10:00:00.000Z',
      createdAt: 1,
      updatedAt: 5,
      messageCount: messages.length,
      messages,
    });
    await vfs.writeFile(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename,
          title: 'OpTel planning',
          frozenAt: '2026-09-09T10:00:00.000Z',
          messageCount: messages.length,
          sessionId,
        },
      ])
    );

    // Tool call 1: search
    const built = await rebuildSessionSearchIndex(vfs);
    expect(built.docs).toBeGreaterThan(0);
    const hits = await searchSessions(vfs, 'OpTel budget', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // Original assistant answer must outrank the summary + prior search echo.
    expect(hits[0].echoKind).toBe('original');
    expect(hits[0].excerpt.toLowerCase()).toMatch(/12/);
    // Debug: ensure the hit id is readable.
    expect(hits[0].id).toMatch(/^sess\//);
    expect(hits[0].sessionId).toBe(sessionId);
    expect(hits[0].messageId).toBeTruthy();

    const searchOut = hits.map((h) => `id=${h.id}\n  ${h.excerpt}`).join('\n');
    expect(searchOut.length).toBeLessThan(8_000);

    // Tool call 2: read the top hit
    const page = await readSessionHit(vfs, hits[0].id, { count: 2 });
    expect(page).not.toBeNull();
    expect(page!.text.toLowerCase()).toMatch(/12,?000|twelve thousand/);
    expect(page!.text.length).toBeLessThanOrEqual(SESSION_READ_BYTE_CAP);

    // Acceptance: ≤3 tool calls totaling <20 KB
    const totalBytes = searchOut.length + (page?.text.length ?? 0);
    expect(totalBytes).toBeLessThan(20_000);

    // Hit id round-trip
    expect(parseHitId(makeHitId(sessionId, 'a0'))).toEqual({
      sessionId,
      messageId: 'a0',
    });
  });

  it('indexes scoop session snapshots under /scoops/<folder>/sessions/<jid>/', async () => {
    // Cone archive with unrelated content.
    const coneFile = '2026-09-11T09-00-00-000Z-weather.md';
    await vfs.writeFile(
      `${SESSIONS_DIR}/${coneFile}`,
      formatArchiveAsMarkdown({
        id: 'cone-1',
        title: 'Weather chat',
        frozenAt: '2026-09-11T09:00:00.000Z',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [msg('user', 'nice weather today', 'u1')],
      })
    );
    await vfs.writeFile(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: coneFile,
          title: 'Weather chat',
          frozenAt: '2026-09-11T09:00:00.000Z',
          messageCount: 1,
          sessionId: 'cone-1',
        },
      ])
    );

    // Scoop snapshot: the fact lives ONLY here.
    const scoopDir = '/scoops/zesty-custard/sessions/agent_zesty_custard';
    const scoopFile = 'live-zesty-abc.md';
    await vfs.mkdir(scoopDir, { recursive: true });
    await vfs.writeFile(
      `${scoopDir}/${scoopFile}`,
      formatArchiveAsMarkdown({
        id: 'scoop-1',
        title: 'Zesty research',
        frozenAt: '2026-09-11T10:00:00.000Z',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [msg('assistant', 'The kumquat quota is forty-two crates.', 'a1')],
      })
    );
    await vfs.writeFile(
      `${scoopDir}/index.json`,
      JSON.stringify([
        {
          filename: scoopFile,
          title: 'Zesty research',
          frozenAt: '2026-09-11T10:00:00.000Z',
          messageCount: 1,
          sessionId: 'scoop-1',
        },
      ])
    );

    const built = await rebuildSessionSearchIndex(vfs);
    expect(built.archives).toBe(2);

    const hits = await searchSessions(vfs, 'kumquat quota', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sessionId).toBe('scoop-1');
    expect(hits[0].path).toBe(`${scoopDir}/${scoopFile}`);

    // session read must resolve the scoop entry too.
    const page = await readSessionHit(vfs, hits[0].id, { count: 1 });
    expect(page).not.toBeNull();
    expect(page!.hit.path).toBe(`${scoopDir}/${scoopFile}`);
    expect(page!.text).toContain('forty-two crates');
  });

  it('rebuilds a stale index when a scoop snapshot appears after the last build', async () => {
    await vfs.writeFile('/sessions/index.json', JSON.stringify([]));
    await rebuildSessionSearchIndex(vfs);
    expect(await searchSessions(vfs, 'gooseberry', { limit: 5 })).toHaveLength(0);

    const scoopDir = '/scoops/late-scoop/sessions/agent_late_scoop';
    await vfs.mkdir(scoopDir, { recursive: true });
    await vfs.writeFile(
      `${scoopDir}/live-late.md`,
      formatArchiveAsMarkdown({
        id: 'late-1',
        title: 'Late scoop',
        frozenAt: '2026-09-11T11:00:00.000Z',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [msg('assistant', 'gooseberry inventory counted', 'a1')],
      })
    );
    await vfs.writeFile(
      `${scoopDir}/index.json`,
      JSON.stringify([
        {
          filename: 'live-late.md',
          title: 'Late scoop',
          frozenAt: '2026-09-11T11:00:00.000Z',
          messageCount: 1,
          sessionId: 'late-1',
        },
      ])
    );

    // No manual rebuild: the fingerprint mismatch must trigger one.
    const hits = await searchSessions(vfs, 'gooseberry', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sessionId).toBe('late-1');
  });

  it('degrades to first-dir-wins when a cone archive and scoop snapshot share a sessionId', async () => {
    const shared = {
      frozenAt: '2026-09-11T12:00:00.000Z',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
    };
    await vfs.writeFile(
      `${SESSIONS_DIR}/dup.md`,
      formatArchiveAsMarkdown({
        ...shared,
        id: 'dup-1',
        title: 'Cone copy',
        messages: [msg('user', 'tamarind ledger cone copy', 'm1')],
      })
    );
    await vfs.writeFile(
      '/sessions/index.json',
      JSON.stringify([{ filename: 'dup.md', title: 'Cone copy', ...shared, sessionId: 'dup-1' }])
    );
    const scoopDir = '/scoops/dup/sessions/agent_dup';
    await vfs.mkdir(scoopDir, { recursive: true });
    await vfs.writeFile(
      `${scoopDir}/dup.md`,
      formatArchiveAsMarkdown({
        ...shared,
        id: 'dup-1',
        title: 'Scoop copy',
        messages: [msg('user', 'tamarind ledger scoop copy', 'm1')],
      })
    );
    await vfs.writeFile(
      `${scoopDir}/index.json`,
      JSON.stringify([{ filename: 'dup.md', title: 'Scoop copy', ...shared, sessionId: 'dup-1' }])
    );

    // Must not throw (MiniSearch rejects duplicate ids); cone wins.
    const built = await rebuildSessionSearchIndex(vfs);
    expect(built.archives).toBe(2);
    const hits = await searchSessions(vfs, 'tamarind ledger', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe(`${SESSIONS_DIR}/dup.md`);
  });

  it('weights title matches above body-only matches', () => {
    const titleHit = docsFromArchive({
      sessionId: 's1',
      sessionTitle: 'OpTel budget review',
      filename: 'a.md',
      messages: [msg('user', 'unrelated body text about weather', 'u1')],
    });
    const bodyHit = docsFromArchive({
      sessionId: 's2',
      sessionTitle: 'Weekly notes',
      filename: 'b.md',
      messages: [msg('user', 'Mention of OpTel budget buried in the body', 'u2')],
    });
    expect(titleHit[0].title).toContain('OpTel');
    expect(bodyHit[0].body).toContain('OpTel');
    expect(titleHit[0].title).not.toEqual(bodyHit[0].title);
  });

  it('caps indexed bodies and measures read pages in UTF-8 bytes', () => {
    const huge = 'x'.repeat(SESSION_INDEX_BODY_BYTE_CAP + 5000);
    const docs = docsFromArchive({
      sessionId: 's3',
      sessionTitle: 'Huge tool output',
      filename: 'c.md',
      messages: [
        msg('assistant', 'ok', 'a1', {
          toolCalls: [{ id: 't1', name: 'bash', input: {}, result: huge }],
        }),
      ],
    });
    expect(docs[0].body.length).toBeLessThanOrEqual(SESSION_INDEX_BODY_BYTE_CAP);

    const cjk = '字'.repeat(8_000);
    const capped = truncateUtf8(cjk, SESSION_READ_BYTE_CAP);
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(SESSION_READ_BYTE_CAP);
    expect(capped.length).toBeLessThan(cjk.length);
  });
});
