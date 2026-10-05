# Freezer Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user delete a frozen chat from the desktop Freezer rail (trash icon → confirm), removing every file it owns, with no path that resurrects it or orphans its data.

**Architecture:** A page-realm `deleteFrozenSession` runs inside the existing `/sessions/index.json` transaction (`serializeIndexWrite`, Web Lock `slicc:sessions-index`) and removes files first, the index row last, so a failure is retryable. Every other index writer becomes update-if-present under the same lock, enrichment detects a mid-pass delete, and the post-freeze pipeline asks the index before spending on a curator. `<slicc-freezer-card>` gets an opt-in `deletable` trash button; a small rail module owns the confirm dialog.

**Tech Stack:** TypeScript; Vitest (webapp: node/jsdom + `fake-indexeddb`; webcomponents: `@vitest/browser` Chromium); Biome; vanilla web components.

**Spec:** `docs/superpowers/specs/2026-10-05-freezer-delete-design.md`

## Global Constraints

- Work in `/Users/kpauls/projects/adobe/github/slicc/.worktrees/feat-freezer-delete` (branch `feat/freezer-delete`); run every command from that root.
- Biome errors apply to every file (no debt lists exist): cognitive complexity ≤ 25, ≤ 150 counted lines per function, `noFloatingPromises` / `noMisusedPromises` (prefix deliberately un-awaited promises with `void`). Check touched files with `npx biome check --write <files>`.
- `wireFreezerRail` (`packages/webapp/src/ui/wc/wc-live-freezer.ts`) is at 145/150 counted lines — Task 10 moves code out of it before adding any.
- Webcomponents: no `innerHTML` (use `h()` / `iconEl()`), never import from the webapp package.
- No new `Record<string, unknown>` in non-test source.
- Layers: `ui/` may import `scoops/`, `transcript/`, `kernel/` types; `transcript/` and `scoops/` never import `ui/`.
- `packages/webapp/src/transcript/snapshot-store.ts` is on the kernel worker's first-load graph (static import from `scoops/orchestrator.ts`): new code there may only `import()` other modules dynamically.
- Error codes crossing the VFS RPC: in new code test `(err as { code?: unknown } | null)?.code === 'ENOENT'`, never `instanceof FsError`.
- Only a freeze creates `/sessions/index.json` rows; every other writer updates rows still present, inside `serializeIndexWrite`.
- UI copy, verbatim: heading `Delete frozen chat?`; body `“<title>” and its transcript will be permanently deleted. Memories already learned from it are kept.`; buttons `Delete` / `Cancel`; inline error `Couldn't delete everything — try again.`; trash button `aria-label="Delete “<title>”"`, `title="Delete"`.
- Commits: conventional message, body ends with `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`; rebase only, never merge commits.

## File Structure

| File                                                                                                                | Responsibility                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Create `packages/webapp/src/transcript/frozen-session-identity.ts`                                                  | Path-safety + identity rules for one index row; tri-state index read                           |
| Create `packages/webapp/src/ui/frozen-session-delete.ts`                                                            | `deleteFrozenSession`, artifact removal, presence check, curator-byproduct sweep               |
| Create `packages/webapp/src/ui/wc/wc-freezer-delete.ts`                                                             | Rail flow: `freezer-card-delete` → confirm dialog → delete → leave / refresh / focus           |
| Modify `transcript/frozen-archive-format.ts`, `transcript/frozen-archive-writer.ts`, `transcript/session-jsonl.ts`  | `sessionId:` frontmatter (#3807)                                                               |
| Modify `ui/session-freezer.ts`                                                                                      | archive `sessionId`; `replaceIndexEntry` outcomes                                              |
| Modify `scoops/live-session-snapshot.ts`                                                                            | archive `sessionId`                                                                            |
| Modify `ui/wc/wc-freezer.ts`                                                                                        | rebuild reads `sessionId`; locked icon write; `recoverCorruptFreezerIndex`; `deletable` cards  |
| Modify `scoops/merge-folded-cost-into-frozen.ts`                                                                    | locked update-if-present                                                                       |
| Modify `transcript/snapshot-store.ts`, `transcript/export-service.ts`, `ui/wc/wc-live.ts`, `scoops/orchestrator.ts` | snapshot removal + discard-after-capture                                                       |
| Modify `transcript/session-search-index.ts`                                                                         | strict invalidation option; persist-if-current                                                 |
| Modify `scoops/live-session-curation.ts`                                                                            | export `LIVE_DELTA_DIR`                                                                        |
| Modify `ui/new-session.ts`                                                                                          | skip curator / settle for deleted sessions                                                     |
| Modify `packages/webcomponents/src/freezer/slicc-freezer-card.ts` (+ stories)                                       | `deletable` trash button                                                                       |
| Modify `ui/wc/wc-cone-actions.ts`                                                                                   | export dialog builder + button styles                                                          |
| Modify `ui/wc/wc-live-freezer.ts`                                                                                   | module-scope refresh helpers; wire delete                                                      |
| Docs                                                                                                                | `README.md`, `docs/work-unit.md`, `docs/webcomponents-details.md`, `packages/webapp/CLAUDE.md` |

(Paths without a package prefix are under `packages/webapp/src/`; their tests mirror under `packages/webapp/tests/`.)

Dependencies: Task 1 → 3, 5, 7. Task 2 → 3, 4, 7 (Tasks 2, 3 share `session-freezer.ts`; 2, 4, 10 share `wc-freezer.ts`). Task 4 → 10. Task 5, 6 → 7. Task 7 → 8, 10. Task 9 → 10. Task 11 last. Execute strictly in numeric order.

---

### Task 1: Frozen-session identity and path-safety helpers

**Files:**

- Create: `packages/webapp/src/transcript/frozen-session-identity.ts`
- Test: `packages/webapp/tests/transcript/frozen-session-identity.test.ts`

**Interfaces:**

- Consumes: `FrozenSessionIndexEntry`, `SESSIONS_INDEX_PATH` from `transcript/frozen-archive-format.ts`.
- Produces:
  - `interface FrozenSessionKey { filename: string; sessionId?: string }`
  - `interface IndexReader { readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array> }`
  - `isSafeArchiveFilename(name: unknown): name is string`
  - `isSafeSessionKey(key: unknown): key is string`
  - `isChatKeyId(id: string): boolean` (`session-` prefix); `isDraftArchiveName(filename: string): boolean` (`pending-` / `live-` prefix)
  - `trustedSessionId(entries: readonly FrozenSessionIndexEntry[], row: FrozenSessionIndexEntry): string | undefined`
  - `findFrozenRow(entries: readonly FrozenSessionIndexEntry[], key: FrozenSessionKey): FrozenSessionIndexEntry | undefined`
  - `readIndexForPresence(vfs: IndexReader): Promise<FrozenSessionIndexEntry[] | null>`

- [ ] **Step 1: Write the failing test** — create `packages/webapp/tests/transcript/frozen-session-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FrozenSessionIndexEntry } from '../../src/transcript/frozen-archive-format.js';
import {
  findFrozenRow,
  isSafeArchiveFilename,
  isSafeSessionKey,
  readIndexForPresence,
  trustedSessionId,
} from '../../src/transcript/frozen-session-identity.js';

const row = (filename: string, sessionId?: string): FrozenSessionIndexEntry => ({
  filename,
  title: filename,
  frozenAt: '2026-06-01T10:00:00.000Z',
  messageCount: 2,
  ...(sessionId ? { sessionId } : {}),
});

describe('isSafeArchiveFilename', () => {
  it('accepts the names the freezer writes', () => {
    for (const name of [
      '2026-06-01T10-00-00-000Z-fix-build.md',
      'pending-a1b2c3.md',
      'live-cone-x1.md',
    ]) {
      expect(isSafeArchiveFilename(name), name).toBe(true);
    }
  });

  it('rejects traversal, separators, NUL, hidden and non-archive names', () => {
    for (const name of [
      '../shared/CLAUDE.md',
      '/etc/passwd.md',
      'a/b.md',
      'a\\b.md',
      'a\u0000.md',
      '.md',
      '..md',
      '.hidden.md',
      'x..y.md',
      'notes.txt',
      '',
      42,
      undefined,
    ]) {
      expect(isSafeArchiveFilename(name), String(name)).toBe(false);
    }
  });
});

describe('isSafeSessionKey', () => {
  it('accepts UUIDs and archive bases', () => {
    expect(isSafeSessionKey('0b7e2a64-1d1f-4a63-9d5c-3c1f0f0e9a11')).toBe(true);
    expect(isSafeSessionKey('pending-a1b2c3')).toBe(true);
  });

  it('rejects empty, traversal, separators and hidden keys', () => {
    for (const key of ['', '.', '..', 'a/b', 'a\\b', '.tmp-x', 'a..b', undefined]) {
      expect(isSafeSessionKey(key), String(key)).toBe(false);
    }
  });
});

describe('trustedSessionId', () => {
  it('trusts a sessionId no other row shares', () => {
    const a = row('a.md', 'sid-a');
    expect(trustedSessionId([a, row('b.md', 'sid-b')], a)).toBe('sid-a');
  });

  it('distrusts a sessionId another row shares (#3807 collapsed rebuild)', () => {
    const a = row('a.md', 'session-cone');
    expect(trustedSessionId([a, row('b.md', 'session-cone')], a)).toBeUndefined();
  });

  it('has nothing to trust on a legacy row, an unsafe id, or a per-cone chat key', () => {
    const legacy = row('a.md');
    expect(trustedSessionId([legacy], legacy)).toBeUndefined();
    const bad = row('a.md', '../x');
    expect(trustedSessionId([bad], bad)).toBeUndefined();
    // Even when unique: `session-<folder>` is shared by every chat of a cone.
    const chatKey = row('a.md', 'session-cone');
    expect(trustedSessionId([chatKey], chatKey)).toBeUndefined();
  });
});

describe('findFrozenRow', () => {
  it('matches by filename first', () => {
    const a = row('a.md', 'sid');
    expect(findFrozenRow([a], { filename: 'a.md', sessionId: 'other' })).toBe(a);
  });

  it('follows an enrichment rename through a unique sessionId', () => {
    const renamed = row('2026-x-real.md', 'sid');
    expect(findFrozenRow([renamed], { filename: 'pending-x.md', sessionId: 'sid' })).toBe(renamed);
  });

  it('matches nothing on an ambiguous sessionId or a missing key', () => {
    const rows = [row('a.md', 'dup'), row('b.md', 'dup')];
    expect(findFrozenRow(rows, { filename: 'pending-gone.md', sessionId: 'dup' })).toBeUndefined();
    expect(findFrozenRow(rows, { filename: 'gone.md' })).toBeUndefined();
  });

  it('never follows a sessionId from a canonical (non-draft) name or through a chat key', () => {
    const b = row('2026-b.md', 'sid-b');
    // A stale card for a deleted canonical archive must not resolve to b.
    expect(findFrozenRow([b], { filename: '2026-a.md', sessionId: 'sid-b' })).toBeUndefined();
    const legacy = row('2026-c.md', 'session-cone');
    expect(
      findFrozenRow([legacy], { filename: 'pending-c.md', sessionId: 'session-cone' })
    ).toBeUndefined();
  });
});

describe('readIndexForPresence', () => {
  const reader = (result: string | Error) => ({
    readFile: async (): Promise<string> => {
      if (result instanceof Error) throw result;
      return result;
    },
  });

  it('returns the rows of a well-formed index', async () => {
    expect(await readIndexForPresence(reader(JSON.stringify([row('a.md')])))).toHaveLength(1);
  });

  it('cannot say (null) when the index is missing, unreadable or malformed', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(await readIndexForPresence(reader(missing))).toBeNull();
    expect(await readIndexForPresence(reader('[{"filename": trunc'))).toBeNull();
    expect(await readIndexForPresence(reader('{"not":"an array"}'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/webapp/tests/transcript/frozen-session-identity.test.ts`
Expected: FAIL — cannot resolve `../../src/transcript/frozen-session-identity.js`.

- [ ] **Step 3: Write the implementation** — create `packages/webapp/src/transcript/frozen-session-identity.ts`:

```ts
/**
 * Identity and path-safety rules for one `/sessions/index.json` row.
 *
 * Rows are unvalidated casts — any writer with VFS access, the agent
 * included, can put anything in the index — and the VFS resolves `..`, so
 * every caller that derives a path from a row validates here first. A
 * `sessionId` is only trusted when no other row shares it: indexes rebuilt
 * before #3807 gave every chat of a cone the same per-cone chat key.
 */

import { type FrozenSessionIndexEntry, SESSIONS_INDEX_PATH } from './frozen-archive-format.js';

/** What a caller holds for one frozen session: the rail card's slug and id. */
export interface FrozenSessionKey {
  filename: string;
  sessionId?: string;
}

/** The read the presence oracle needs. */
export interface IndexReader {
  readFile(path: string, options: { encoding: 'utf-8' }): Promise<string | Uint8Array>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_SEGMENT.test(value) &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

/** A direct `/sessions/` child archive: `<safe segment>.md`. */
export function isSafeArchiveFilename(name: unknown): name is string {
  return isSafeSegment(name) && name.endsWith('.md') && name.length > '.md'.length;
}

/** A `sessionId` or archive base usable as one path segment. */
export function isSafeSessionKey(key: unknown): key is string {
  return isSafeSegment(key);
}

/** A per-cone chat key (`session-<folder>`) — never a per-freeze identity (#3807). */
export function isChatKeyId(id: string): boolean {
  return id.startsWith('session-');
}

/** Provisional archive names an enrichment may still rename (`pending-` / `live-`). */
export function isDraftArchiveName(filename: string): boolean {
  return filename.startsWith('pending-') || filename.startsWith('live-');
}

/**
 * `row.sessionId` when it is a path-safe per-freeze id (not a chat key) and
 * no OTHER row in `entries` shares it.
 */
export function trustedSessionId(
  entries: readonly FrozenSessionIndexEntry[],
  row: FrozenSessionIndexEntry
): string | undefined {
  const id = row.sessionId;
  if (!isSafeSessionKey(id) || isChatKeyId(id)) return undefined;
  return entries.some((entry) => entry !== row && entry.sessionId === id) ? undefined : id;
}

/**
 * The row a key names: by filename first. Only a DRAFT name (which an
 * enrichment may have renamed between render and use) falls back to the
 * one row carrying the key's trusted `sessionId`; anything else matches
 * nothing, so a stale card can never resolve to a different chat.
 */
export function findFrozenRow(
  entries: readonly FrozenSessionIndexEntry[],
  key: FrozenSessionKey
): FrozenSessionIndexEntry | undefined {
  const byName = entries.find((entry) => entry.filename === key.filename);
  if (byName || !key.sessionId || !isDraftArchiveName(key.filename)) return byName;
  const byId = entries.filter((entry) => entry.sessionId === key.sessionId);
  const only = byId.length === 1 ? byId[0] : undefined;
  return only && trustedSessionId(entries, only) === key.sessionId ? only : undefined;
}

/**
 * The index as a presence oracle: its rows, or `null` when it cannot say
 * (missing, unreadable, malformed). Never read `null` as "absent" — a
 * corrupt index is not a deleted session.
 */
export async function readIndexForPresence(
  vfs: IndexReader
): Promise<FrozenSessionIndexEntry[] | null> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(
      typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    );
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/webapp/tests/transcript/frozen-session-identity.test.ts && npx biome check --write packages/webapp/src/transcript/frozen-session-identity.ts packages/webapp/tests/transcript/frozen-session-identity.test.ts`
Expected: all tests PASS; Biome reports no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/transcript/frozen-session-identity.ts packages/webapp/tests/transcript/frozen-session-identity.test.ts
git commit -m "feat(webapp): frozen-session identity and path-safety helpers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Persist the per-freeze `sessionId` in archive frontmatter (#3807)

**Files:**

- Modify: `packages/webapp/src/transcript/frozen-archive-format.ts` (`FrozenSessionArchive`, `parseFrozenArchive`, `parseFrontmatterMeta`)
- Modify: `packages/webapp/src/transcript/frozen-archive-writer.ts` (`formatArchiveAsMarkdown` header)
- Modify: `packages/webapp/src/transcript/session-jsonl.ts` (`loadFrozenArchive` return type)
- Modify: `packages/webapp/src/ui/session-freezer.ts` (`writeFrozenArchive`, ~line 523)
- Modify: `packages/webapp/src/scoops/live-session-snapshot.ts` (~line 181)
- Modify: `packages/webapp/src/ui/wc/wc-freezer.ts` (`entryFromArchive`, ~line 181)
- Test: `packages/webapp/tests/transcript/frozen-archive-writer.test.ts`, `packages/webapp/tests/ui/wc/wc-freezer.test.ts`, `packages/webapp/tests/ui/session-freezer.test.ts`

**Interfaces:**

- Produces: `FrozenSessionArchive.sessionId?: string`; `parseFrozenArchive(...)` / `loadFrozenArchive(...)` results gain `sessionId?: string`; archives carry a `sessionId: <uuid>` frontmatter line right after `id:`.

- [ ] **Step 1: Write the failing tests**

In `packages/webapp/tests/transcript/frozen-archive-writer.test.ts`, inside `describe('formatArchiveAsMarkdown', ...)`, add:

```ts
it('writes the per-freeze sessionId beside the chat-key id and reads it back (#3807)', () => {
  const markdown = formatArchiveAsMarkdown({
    id: 'session-cone',
    sessionId: '0b7e2a64-1d1f-4a63-9d5c-3c1f0f0e9a11',
    title: 't',
    frozenAt: 'now',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    messages: [user],
  });
  expect(markdown).toMatch(
    /^---\nid: session-cone\nsessionId: 0b7e2a64-1d1f-4a63-9d5c-3c1f0f0e9a11\n/
  );
  const parsed = parseFrozenArchive(markdown);
  expect(parsed.id).toBe('session-cone');
  expect(parsed.sessionId).toBe('0b7e2a64-1d1f-4a63-9d5c-3c1f0f0e9a11');
});

it('omits the sessionId line when the archive has none', () => {
  const markdown = formatArchiveAsMarkdown({
    id: 'sid',
    title: 't',
    frozenAt: 'now',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    messages: [user],
  });
  expect(markdown).not.toContain('sessionId:');
  expect(parseFrozenArchive(markdown).sessionId).toBeUndefined();
});
```

In `packages/webapp/tests/ui/wc/wc-freezer.test.ts`, inside `describe('corrupt-index recovery', ...)`, add:

```ts
it('rebuilds sessionId from the sessionId frontmatter, never from a per-cone chat key (#3807)', async () => {
  const fs = await seededFs();
  const archive = (title: string, frozenAt: string, extra: string[]) =>
    [
      '---',
      'id: session-cone',
      ...extra,
      `title: "${title}"`,
      `frozenAt: "${frozenAt}"`,
      'messageCount: 2',
      '---',
      '',
    ].join('\n');
  await fs.writeFile(
    '/sessions/2026-06-04T09-00-00Z-a.md',
    archive('a', '2026-06-04T09:00:00Z', ['sessionId: sid-a'])
  );
  await fs.writeFile(
    '/sessions/2026-06-05T09-00-00Z-b.md',
    archive('b', '2026-06-05T09:00:00Z', [])
  );
  await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');

  const rebuilt = await rebuildFreezerIndexFromArchives(fs);
  const byName = new Map(rebuilt.map((entry) => [entry.filename, entry]));
  expect(byName.get('2026-06-04T09-00-00Z-a.md')?.sessionId).toBe('sid-a');
  // A legacy archive only carries the cone's chat key — shared by every
  // chat that cone ever froze — so it must not become this row's identity.
  expect(byName.get('2026-06-05T09-00-00Z-b.md')?.sessionId).toBeUndefined();
});
```

In `packages/webapp/tests/ui/session-freezer.test.ts`, inside `describe('freezeConeSession — sessionId generation', ...)`, add:

```ts
it('writes the sessionId into the archive frontmatter beside the chat key (#3807)', async () => {
  const vfs = makeFakeVfs();
  const result = await freezeConeSession({
    sessionStore: makeFakeStore({
      id: 'session-cone',
      messages: [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')],
      createdAt: 1,
      updatedAt: 2,
    }),
    vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
    model: fakeModel,
    apiKey: 'k',
    mode: 'quick',
  });
  const markdown = vfs.files.get(`/sessions/${result!.filename}`)!;
  expect(markdown).toContain('id: session-cone\n');
  expect(markdown).toContain(`sessionId: ${result!.sessionId}\n`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/transcript/frozen-archive-writer.test.ts packages/webapp/tests/ui/wc/wc-freezer.test.ts packages/webapp/tests/ui/session-freezer.test.ts -t "sessionId"`
Expected: the new tests FAIL (no `sessionId:` line; rebuilt `b` row gets `session-cone`).

- [ ] **Step 3: Implement**

1. `frozen-archive-format.ts` — in `interface FrozenSessionArchive`, directly after `id: string;` add:

```ts
  /**
   * Per-freeze identity: the index row's `sessionId` (#3807). `id` is the
   * cone's chat key (`session-<folder>`), the same for every chat that cone
   * ever froze — an index rebuild must read this field, not `id`.
   */
  sessionId?: string;
```

2. Widen the four extra-meta intersections (3 in `frozen-archive-format.ts`, 1 in `session-jsonl.ts`):

```bash
node -e 'const fs=require("fs");for(const f of ["packages/webapp/src/transcript/frozen-archive-format.ts","packages/webapp/src/transcript/session-jsonl.ts"]){const s=fs.readFileSync(f,"utf8");const n=s.split("& { id?: string; sidecar?: string }").length-1;fs.writeFileSync(f,s.split("& { id?: string; sidecar?: string }").join("& { id?: string; sessionId?: string; sidecar?: string }"));console.log(f,n)}'
```

Expected output: `...frozen-archive-format.ts 3` and `...session-jsonl.ts 1`.

3. `frozen-archive-format.ts` `parseFrontmatterMeta` — right after `if (id) meta.id = id;` add:

```ts
const sessionId = frontmatter.match(/^sessionId:\s*(\S+)\s*$/m)?.[1];
if (sessionId) meta.sessionId = sessionId;
```

4. `frozen-archive-writer.ts` `formatArchiveAsMarkdown` — in the `header` concatenation replace

```ts
    `id: ${archive.id}\n` +
```

with

```ts
    `id: ${archive.id}\n` +
    (archive.sessionId ? `sessionId: ${archive.sessionId}\n` : '') +
```

5. `ui/session-freezer.ts` `writeFrozenArchive` — in the `const archive: FrozenSessionArchive = {` literal replace `id: session.id,` with:

```ts
      id: session.id,
      sessionId,
```

6. `scoops/live-session-snapshot.ts` — replace

```ts
  const archive: FrozenSessionArchive = {
    id: existing?.sessionId ?? crypto.randomUUID(),
```

with

```ts
  const sessionId = existing?.sessionId ?? crypto.randomUUID();
  const archive: FrozenSessionArchive = {
    id: sessionId,
    sessionId,
```

7. `ui/wc/wc-freezer.ts` — add above `entryFromArchive`:

```ts
/**
 * The per-freeze id a rebuilt row may carry (#3807): the `sessionId:` line,
 * else a live snapshot's `id:` — never a freeze's `id:`, which is the cone's
 * chat key (`session-<folder>`) shared by every chat that cone froze.
 */
function rebuiltSessionId(parsed: { id?: string; sessionId?: string }): string | undefined {
  if (parsed.sessionId) return parsed.sessionId;
  return parsed.id && !parsed.id.startsWith('session-') ? parsed.id : undefined;
}
```

In `entryFromArchive`, add `const sessionId = rebuiltSessionId(parsed);` right before `return {`, and replace `...(parsed.id ? { sessionId: parsed.id } : {}),` with `...(sessionId ? { sessionId } : {}),`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/transcript/frozen-archive-writer.test.ts packages/webapp/tests/ui/wc/wc-freezer.test.ts packages/webapp/tests/ui/wc/wc-freezer-live.test.ts packages/webapp/tests/ui/session-freezer.test.ts packages/webapp/tests/scoops/live-session-snapshot.test.ts packages/webapp/tests/transcript/session-search.test.ts`
Expected: all PASS (existing `wc-freezer-live` rebuild test keeps `id: sid-1` → `sessionId: 'sid-1'`).
Then: `npx biome check --write packages/webapp/src/transcript packages/webapp/src/ui/session-freezer.ts packages/webapp/src/scoops/live-session-snapshot.ts packages/webapp/src/ui/wc/wc-freezer.ts` — no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src packages/webapp/tests
git commit -m "fix(webapp): persist the per-freeze sessionId in archive frontmatter

An index rebuild promoted the archive's per-cone chat key to sessionId, so
every chat of a cone shared one id. Fixes #3807.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Enrichment can tell a delete or a rival from a lost index

**Files:**

- Modify: `packages/webapp/src/ui/session-freezer.ts` — `replaceIndexEntry` (~line 1615) and its call in `commitEnrichedArchive` (~line 1418)
- Test: `packages/webapp/tests/ui/session-freezer.test.ts`

**Interfaces:**

- Consumes: `isChatKeyId` (Task 1); `removeSessionJsonl`, `SESSIONS_DIR`, `SESSIONS_INDEX_PATH`, `FsError`, `serializeIndexWrite` are already imported there.
- Produces (module-internal): `type ReplaceIndexOutcome = 'replaced' | 'prepended' | 'superseded' | 'deleted'`; `enrichPendingSession` keeps its signature and returns `null` for `superseded` / `deleted`.

- [ ] **Step 1: Write the failing tests** — append to `packages/webapp/tests/ui/session-freezer.test.ts`:

```ts
describe('enrichPendingSession — a delete or a rival enrichment mid-pass', () => {
  beforeEach(() => {
    mockRunOneOffCompactionCall.mockReset();
    mockRunOneOffCompactionCall.mockImplementation(async (opts: { instruction: string }) =>
      opts.instruction === 'TITLE' ? 'Build pipeline debug' : 'NONE'
    );
    mockApplyConeMemoryBudget.mockReset();
    mockApplyConeMemoryBudget.mockResolvedValue({ restructured: false, reason: 'no-llm' });
  });

  async function seed(vfs: ReturnType<typeof makeFakeVfs>) {
    const result = await freezeConeSession({
      sessionStore: makeFakeStore({
        id: 'session-cone',
        messages: [
          userMessage('debug the build pipeline'),
          assistantMessage('looking'),
          userMessage('thanks'),
          assistantMessage('np'),
        ],
        createdAt: 100,
        updatedAt: 200,
      }),
      vfs: vfs as unknown as Parameters<typeof freezeConeSession>[0]['vfs'],
      model: fakeModel,
      apiKey: 'k',
      mode: 'quick',
    });
    return result!;
  }

  /** Run `land` right after the enrichment writes its renamed archive. */
  function onRenamedWrite(vfs: ReturnType<typeof makeFakeVfs>, land: () => Promise<void>): void {
    const write = vfs.writeFile.bind(vfs);
    let landed = false;
    vfs.writeFile = async (path: string, content: string | Uint8Array) => {
      await write(path, content);
      if (!landed && path.endsWith('-build-pipeline-debug.md')) {
        landed = true;
        await land();
      }
    };
  }

  const enrich = (vfs: ReturnType<typeof makeFakeVfs>, entry: FrozenSessionIndexEntry) =>
    enrichPendingSession(vfs as unknown as Parameters<typeof enrichPendingSession>[0], entry, {
      model: fakeModel!,
      apiKey: 'k',
    });
  const readIndex = (vfs: ReturnType<typeof makeFakeVfs>) =>
    readSessionsIndex(vfs as unknown as Parameters<typeof readSessionsIndex>[0]);
  const renamedCopies = (vfs: ReturnType<typeof makeFakeVfs>) =>
    [...vfs.files.keys()].filter((path) => path.includes('-build-pipeline-debug.'));

  it('a delete landing mid-enrichment is not undone: no row comes back, the renamed copy is dropped', async () => {
    const vfs = makeFakeVfs();
    const frozen = await seed(vfs);
    onRenamedWrite(vfs, async () => {
      vfs.files.delete(`/sessions/${frozen.filename}`);
      vfs.files.set(SESSIONS_INDEX_PATH, '[]');
    });

    expect(await enrich(vfs, frozen)).toBeNull();
    expect(await readIndex(vfs)).toEqual([]);
    expect(renamedCopies(vfs)).toEqual([]);
  });

  it('a rival enrichment that already moved the session on wins; this pass writes nothing', async () => {
    const vfs = makeFakeVfs();
    const frozen = await seed(vfs);
    const { archive: _archive, pendingEnrichment: _pending, ...rest } = frozen;
    const winner: FrozenSessionIndexEntry = {
      ...rest,
      filename: '2026-01-01T00-00-00-000Z-rival-title.md',
      title: 'Rival title',
    };
    onRenamedWrite(vfs, async () => {
      vfs.files.delete(`/sessions/${frozen.filename}`);
      vfs.files.set(`/sessions/${winner.filename}`, 'rival archive');
      vfs.files.set(SESSIONS_INDEX_PATH, JSON.stringify([winner]));
    });

    expect(await enrich(vfs, frozen)).toBeNull();
    expect((await readIndex(vfs)).map((entry) => entry.filename)).toEqual([winner.filename]);
    expect(vfs.files.get(`/sessions/${winner.filename}`)).toBe('rival archive');
    expect(renamedCopies(vfs)).toEqual([]);
  });

  it('keeps the prepend when the index lost the row but the draft archive survives', async () => {
    const vfs = makeFakeVfs();
    const frozen = await seed(vfs);
    vfs.files.set(SESSIONS_INDEX_PATH, '[]');

    const updated = await enrich(vfs, frozen);
    expect(updated?.filename).toMatch(/-build-pipeline-debug\.md$/);
    expect((await readIndex(vfs)).map((entry) => entry.filename)).toEqual([updated!.filename]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/session-freezer.test.ts -t "mid-pass"`
Expected: the first two FAIL (today the missing old row is prepended back); the third PASSES.

- [ ] **Step 3: Implement** — in `packages/webapp/src/ui/session-freezer.ts` replace the whole `replaceIndexEntry` function (doc comment included) with:

```ts
/**
 * How {@link replaceIndexEntry} resolved an enrichment's index swap:
 * `replaced` / `prepended` wrote the replacement; `superseded` (a rival
 * enrichment already moved the session on) and `deleted` (the user deleted
 * it mid-pass) wrote nothing and dropped this pass's renamed copy.
 */
type ReplaceIndexOutcome = 'replaced' | 'prepended' | 'superseded' | 'deleted';

/**
 * Swap one entry in the sessions index by filename. Used by the
 * enrichment pass to flip a `pending-…` entry over to its renamed
 * canonical form. Writes are serialized via `serializeIndexWrite`.
 *
 * When the old row is gone, the archive decides: still on disk means the
 * index was lost or rebuilt (prepend the replacement, as before); gone
 * means the session was deleted — unless a row already carries the
 * replacement's filename or its one `sessionId`, i.e. a rival won.
 */
async function replaceIndexEntry(
  vfs: WritableVfsClient,
  oldFilename: string,
  replacement: FrozenSessionIndexEntry
): Promise<ReplaceIndexOutcome> {
  const run = async (): Promise<ReplaceIndexOutcome> => {
    const existing = await readIndexForReplace(vfs);
    const idx = existing.findIndex((e) => e.filename === oldFilename);
    if (idx !== -1) {
      const updated = existing.slice();
      updated[idx] = replacement;
      const deduped = updated.filter((e, i) => i === idx || e.filename !== replacement.filename);
      await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(deduped, null, 2));
      return 'replaced';
    }
    const outcome = await resolveMissingOldRow(vfs, existing, oldFilename, replacement);
    if (outcome === 'prepended') {
      const updated = [replacement, ...existing.filter((e) => e.filename !== replacement.filename)];
      await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    } else if (outcome === 'replaced') {
      // The canonical row already exists (#718): swap it in place, never duplicate.
      const updated = existing.map((e) => (e.filename === replacement.filename ? replacement : e));
      await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
    } else {
      await dropUnreferencedCopy(vfs, existing, oldFilename, replacement.filename);
    }
    return outcome;
  };
  return serializeIndexWrite(run);
}

/** The index for {@link replaceIndexEntry}: missing is empty; a read or parse fault throws. */
async function readIndexForReplace(vfs: WritableVfsClient): Promise<FrozenSessionIndexEntry[]> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch (err) {
    if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
    return [];
  }
}

/**
 * The old row is gone. A row already carrying the replacement's filename is
 * the canonical row (#718) — replace it in place. Otherwise the ONE row with
 * the replacement's trusted `sessionId` means a rival enrichment won; else the
 * old archive decides between a lost index (prepend) and a delete.
 */
async function resolveMissingOldRow(
  vfs: WritableVfsClient,
  existing: readonly FrozenSessionIndexEntry[],
  oldFilename: string,
  replacement: FrozenSessionIndexEntry
): Promise<ReplaceIndexOutcome> {
  if (existing.some((e) => e.filename === replacement.filename)) return 'replaced';
  const sessionId = replacement.sessionId;
  const sameId =
    sessionId && !isChatKeyId(sessionId) ? existing.filter((e) => e.sessionId === sessionId) : [];
  if (sameId.length === 1) return 'superseded';
  return (await archiveExists(vfs, `${SESSIONS_DIR}/${oldFilename}`)) ? 'prepended' : 'deleted';
}

/** `false` only for a definite ENOENT — any other stat fault keeps the archive "present". */
async function archiveExists(vfs: WritableVfsClient, path: string): Promise<boolean> {
  try {
    await vfs.stat(path);
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code !== 'ENOENT';
  }
}

/** Remove this pass's renamed archive + sidecar unless a row already points at them. */
async function dropUnreferencedCopy(
  vfs: WritableVfsClient,
  existing: readonly FrozenSessionIndexEntry[],
  oldFilename: string,
  newFilename: string
): Promise<void> {
  if (newFilename === oldFilename || existing.some((e) => e.filename === newFilename)) return;
  try {
    await vfs.rm(`${SESSIONS_DIR}/${newFilename}`);
  } catch {
    /* already gone */
  }
  try {
    await removeSessionJsonl(vfs, newFilename);
  } catch {
    /* already gone */
  }
}
```

Add this helper right after `dropUnreferencedCopy` (it keeps `commitEnrichedArchive` under Biome's cognitive-complexity cap of 25 — the function is at exactly 25 today):

```ts
/** Swap the row; `false` when the pass must stop (index fault, a rival won, or deleted). */
async function commitIndexSwap(
  vfs: WritableVfsClient,
  entry: FrozenSessionIndexEntry,
  updated: FrozenSessionIndexEntry
): Promise<boolean> {
  let outcome: ReplaceIndexOutcome;
  try {
    outcome = await replaceIndexEntry(vfs, entry.filename, updated);
  } catch (err) {
    log.warn('Enrichment index update failed (entry may stay pending)', {
      filename: entry.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (outcome === 'superseded' || outcome === 'deleted') {
    // The session moved on while this pass ran — a rival enrichment won or
    // the user deleted it. The index lock already dropped this pass's copy.
    log.info('Enrichment dropped — the session changed during the pass', {
      filename: entry.filename,
      outcome,
    });
    return false;
  }
  return true;
}
```

Then in `commitEnrichedArchive` replace the whole block

```ts
try {
  await replaceIndexEntry(vfs, entry.filename, updatedEntry);
} catch (err) {
  log.warn('Enrichment index update failed (entry may stay pending)', {
    filename: entry.filename,
    error: err instanceof Error ? err.message : String(err),
  });
  return null;
}
```

with

```ts
if (!(await commitIndexSwap(vfs, entry, updatedEntry))) return null;
```

Finally add `import { isChatKeyId } from '../transcript/frozen-session-identity.js';` to the imports (run `npx biome check --write --write` to place it).

Also add a regression test for two enrichments of the SAME draft (same title → same canonical name) to the new describe block:

```ts
it('two concurrent enrichments of the same draft keep one row and the canonical archive', async () => {
  const vfs = makeFakeVfs();
  const frozen = await seed(vfs);
  const [first, second] = await Promise.all([enrich(vfs, frozen), enrich(vfs, frozen)]);

  const winner = first ?? second;
  expect(winner?.filename).toMatch(/-build-pipeline-debug\.md$/);
  expect((await readIndex(vfs)).map((entry) => entry.filename)).toEqual([winner!.filename]);
  expect(vfs.files.has(`/sessions/${winner!.filename}`)).toBe(true);
  expect(vfs.files.has(`/sessions/${frozen.filename}`)).toBe(false);
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/session-freezer.test.ts && npx biome check --write packages/webapp/src/ui/session-freezer.ts`
Expected: the whole file PASSES — including the existing #718 regression "does not duplicate the canonical row when it already exists in the index" (now `replaced` in place) and "two concurrent enrichments"; Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/session-freezer.ts packages/webapp/tests/ui/session-freezer.test.ts
git commit -m "fix(webapp): enrichment no longer resurrects a deleted frozen session

replaceIndexEntry prepended the renamed row whenever the old one was
missing. It now tells a delete (old archive gone) and a rival enrichment
(row with the same sessionId or filename) apart from a lost index.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Every other index writer becomes update-if-present under the lock

**Files:**

- Modify: `packages/webapp/src/ui/wc/wc-freezer.ts` (`enrichFreezerIcons`; new `recoverCorruptFreezerIndex`)
- Modify: `packages/webapp/src/scoops/merge-folded-cost-into-frozen.ts`
- Test: `packages/webapp/tests/ui/wc/wc-freezer.test.ts`, `packages/webapp/tests/scoops/merge-folded-cost-into-frozen.test.ts`

**Interfaces:**

- Consumes: `serializeIndexWrite`, `readSessionsIndexForWrite`, `writeSessionsIndexUnlocked` from `transcript/frozen-archive-writer.ts`.
- Produces: `recoverCorruptFreezerIndex(reader: LocalVfsClient, writer: { writeFile(path: string, content: string): Promise<unknown> }): Promise<FrozenSessionIndexEntry[] | null>` (used by Task 10). `mergeFoldedCostIntoLatestFrozen` keeps its signature.

- [ ] **Step 1: Write the failing tests**

In `packages/webapp/tests/ui/wc/wc-freezer.test.ts` add `recoverCorruptFreezerIndex` to the `wc-freezer.js` import list, add `import { serializeIndexWrite } from '../../../src/transcript/frozen-archive-writer.js';`, then add at the end of the file:

```ts
/** Hold the sessions-index lock until `release()` — a delete "in flight". */
function holdIndexLock(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  void serializeIndexWrite(async () => {
    entered();
    await gate;
  });
  return { held, release };
}

describe('index writers never resurrect a deleted row', () => {
  it('recoverCorruptFreezerIndex rebuilds and publishes a corrupt index', async () => {
    const fs = await seededFs();
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');
    const entries = await recoverCorruptFreezerIndex(fs, fs);
    expect(entries?.map((entry) => entry.filename)).toEqual([ENTRY.filename]);
    expect((await readFreezerEntries(fs))?.map((entry) => entry.filename)).toEqual([
      ENTRY.filename,
    ]);
  });

  it('recoverCorruptFreezerIndex re-checks inside the lock: a delete that landed first wins', async () => {
    const fs = await seededFs();
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');
    const lock = holdIndexLock();
    await lock.held;
    const recovering = recoverCorruptFreezerIndex(fs, fs);
    // The delete removes the archive and writes a repaired index first.
    await fs.rm(`/sessions/${ENTRY.filename}`);
    await fs.writeFile('/sessions/index.json', '[]');
    lock.release();

    expect(await recovering).toEqual([]);
    expect(await readFreezerEntries(fs)).toEqual([]);
  });

  it('enrichFreezerIcons stamps only rows still present when its write runs', async () => {
    const fs = await seededFs();
    const entries = (await readFreezerEntries(fs)) ?? [];
    const other: FrozenSessionIndexEntry = { ...ENTRY, filename: 'other.md', title: 'Other' };
    const lock = holdIndexLock();
    await lock.held;
    const enriching = enrichFreezerIcons({
      reader: fs,
      writer: fs,
      freezer: document.createElement('slicc-freezer'),
      entries,
      pickIcon: async () => 'wrench',
    });
    // ENTRY is deleted and another freeze lands while the pick is in flight.
    await fs.writeFile('/sessions/index.json', JSON.stringify([other]));
    lock.release();
    await enriching;

    const after = (await readFreezerEntries(fs)) ?? [];
    expect(after.map((entry) => entry.filename)).toEqual(['other.md']);
    expect(after[0]?.icon).toBeUndefined();
  });
});
```

In `packages/webapp/tests/scoops/merge-folded-cost-into-frozen.test.ts` add `import { serializeIndexWrite } from '../../src/transcript/frozen-archive-writer.js';` and, inside the existing `describe`, add:

```ts
it('updates in place under the index lock and never re-creates a deleted row', async () => {
  await seedIndex([
    {
      filename: 'newest.md',
      title: 'newest',
      frozenAt: '2026-09-26T00:00:00.000Z',
      messageCount: 4,
      cone: 'cone',
    },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  void serializeIndexWrite(async () => {
    entered();
    await gate;
  });
  await held;

  const merging = mergeFoldedCostIntoLatestFrozen(vfs, { folder: 'cone' }, [
    foldedTurn('claude-haiku-4-5', 0.003),
  ]);
  await seedIndex([]); // deleted while the merge waited for the lock
  release();

  expect(await merging).toBe(false);
  expect(await readSessionsIndex(vfs)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-freezer.test.ts packages/webapp/tests/scoops/merge-folded-cost-into-frozen.test.ts`
Expected: FAIL — `recoverCorruptFreezerIndex` is not exported; the merge test resurrects `newest.md`; the icon test resurrects `ENTRY`.

- [ ] **Step 3: Implement**

`packages/webapp/src/ui/wc/wc-freezer.ts`:

1. Add `import { serializeIndexWrite } from '../../transcript/frozen-archive-writer.js';` with the other imports.
2. In `enrichFreezerIcons`, replace everything from the comment `// Re-read right before the write; refuse to write over a fault, a corrupt` down to (and including) the `await deps.writer.writeFile(SESSIONS_INDEX_PATH, …);` line with:

```ts
// Re-read and write as ONE index transaction: an unlocked read-then-write
// could put back a row deleted (or drop a row frozen) in between. Refuse
// to write over a fault, a corrupt index, OR an empty one (we were called
// with entries — an empty re-read means something is wrong).
const written = await serializeIndexWrite(async () => {
  const current = await readFreezerEntries(deps.reader);
  if (current === null || current.length === 0) return false;
  const updated = current.map((e) => {
    const icon = !e.icon && picked.has(e.filename) ? picked.get(e.filename) : undefined;
    return icon ? { ...e, icon } : e;
  });
  await deps.writer.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(updated, null, 2));
  return true;
});
if (!written) return;
```

(The card-stamping loop after it stays unchanged.)

3. Add after `rebuildFreezerIndexFromArchives`:

```ts
/**
 * Rebuild a corrupt index from the archives and publish it as ONE index
 * transaction, re-checking the corruption inside the lock: a scan taken
 * outside it could publish a row a concurrent delete just removed. Returns
 * the rows to render, or `null` when there is nothing to show.
 */
export function recoverCorruptFreezerIndex(
  reader: LocalVfsClient,
  writer: { writeFile(path: string, content: string): Promise<unknown> }
): Promise<FrozenSessionIndexEntry[] | null> {
  return serializeIndexWrite(async () => {
    const state = await readFreezerIndexState(reader);
    if (state.kind === 'ok') return state.entries;
    if (state.kind !== 'corrupt') return null;
    const entries = await rebuildFreezerIndexFromArchives(reader);
    if (entries.length === 0) return null;
    await writer.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(entries, null, 2));
    return entries;
  });
}
```

`packages/webapp/src/scoops/merge-folded-cost-into-frozen.ts`:

1. Replace the two index imports with:

```ts
import type {
  FrozenSessionCost,
  FrozenSessionIndexEntry,
  FrozenSessionModel,
} from '../transcript/frozen-archive-format.js';
import {
  readSessionsIndexForWrite,
  serializeIndexWrite,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
```

2. Change the type alias to `export type FoldedCostArchiveVfs = Parameters<typeof writeSessionsIndexUnlocked>[0] & LocalVfsClient;`
3. Replace the body of `mergeFoldedCostIntoLatestFrozen` (keep its doc comment and signature) with:

```ts
if (folded.length === 0) return false;
const coneFolder = scoop.folder || PRIMARY_CONE_FOLDER;
// Read and write as ONE index transaction, updating the row in place: a
// stale read followed by an upsert would re-create a row deleted meanwhile.
return serializeIndexWrite(async () => {
  const entries = await readSessionsIndexForWrite(vfs);
  const candidates = entries.filter((entry) => (entry.cone ?? PRIMARY_CONE_FOLDER) === coneFolder);
  if (candidates.length === 0) return false;
  // Newest freeze first — the New-session clear runs moments after the
  // freezer wrote this row, so folding into an older archive would mis-attribute.
  const latest = candidates.reduce((best, entry) =>
    entry.frozenAt > best.frozenAt ? entry : best
  );
  const merged: FrozenSessionIndexEntry = {
    ...latest,
    cost: mergeFrozenCost(latest.cost, folded),
    models: mergeFrozenModels(latest.models, folded),
  };
  await writeSessionsIndexUnlocked(
    vfs,
    entries.map((entry) => (entry === latest ? merged : entry))
  );
  return true;
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-freezer.test.ts packages/webapp/tests/scoops/merge-folded-cost-into-frozen.test.ts packages/webapp/tests/scoops/orchestrator*.test.ts && npx biome check --write packages/webapp/src/ui/wc/wc-freezer.ts packages/webapp/src/scoops/merge-folded-cost-into-frozen.ts`
Expected: PASS; Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/wc/wc-freezer.ts packages/webapp/src/scoops/merge-folded-cost-into-frozen.ts packages/webapp/tests/ui/wc/wc-freezer.test.ts packages/webapp/tests/scoops/merge-folded-cost-into-frozen.test.ts
git commit -m "fix(webapp): freezer index writers update only rows still present

Icon backfill, the corrupt-index rebuild and the folded-cost merge read
the index outside the lock and wrote it back whole, which could restore a
row deleted in between. Each now re-reads inside serializeIndexWrite.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Snapshot removal and discard-after-capture

**Files:**

- Modify: `packages/webapp/src/transcript/snapshot-store.ts`
- Modify: `packages/webapp/src/transcript/export-service.ts` (`ExportServiceDeps.snapshotStore`, `captureFrozen`)
- Modify: `packages/webapp/src/ui/wc/wc-live.ts` (~line 1510, page registration)
- Modify: `packages/webapp/src/scoops/orchestrator.ts` (~line 1917, worker registration)
- Test: `packages/webapp/tests/transcript/snapshot-store.test.ts`, `packages/webapp/tests/transcript/export-service.test.ts`

**Interfaces:**

- Consumes: `serializeIndexWrite` (frozen-archive-writer), `readIndexForPresence` (Task 1) — both via dynamic `import()` only (worker first-load graph).
- Produces:
  - `removeSnapshot(vfs: WritableVfsClient, sessionId: string): Promise<void>` — throws on unsafe id or non-ENOENT fault.
  - `discardSnapshotIfUnindexed(vfs: WritableVfsClient, sessionId: string): Promise<boolean>`
  - `ExportServiceDeps['snapshotStore'].discardIfUnindexed?(sessionId: string): Promise<unknown>`

- [ ] **Step 1: Write the failing tests**

In `packages/webapp/tests/transcript/snapshot-store.test.ts` add `discardSnapshotIfUnindexed` and `removeSnapshot` to the `snapshot-store.js` import, then append:

```ts
describe('removeSnapshot', () => {
  it('removes the published bundle and a leftover staging dir; missing is fine', async () => {
    const vfs = await createVfs();
    await writeSnapshot(vfs, 'sess-rm-001', makeSnapshot());
    await vfs.mkdir('/sessions/data/.tmp-sess-rm-001', { recursive: true });
    await vfs.writeFile('/sessions/data/.tmp-sess-rm-001/document.json', '{}');

    await removeSnapshot(vfs, 'sess-rm-001');

    await expect(vfs.stat('/sessions/data/sess-rm-001')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(vfs.stat('/sessions/data/.tmp-sess-rm-001')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(removeSnapshot(vfs, 'sess-rm-001')).resolves.toBeUndefined();
  });

  it('rejects an unsafe id', async () => {
    const vfs = await createVfs();
    await expect(removeSnapshot(vfs, '../escape')).rejects.toThrow();
  });

  it('surfaces a non-ENOENT removal fault', async () => {
    const failing = {
      rm: async () => {
        throw Object.assign(new Error('EIO: disk'), { code: 'EIO' });
      },
    };
    await expect(removeSnapshot(failing as never, 'sess-x')).rejects.toThrow('EIO');
  });
});

describe('discardSnapshotIfUnindexed', () => {
  async function seeded(index: string | null): Promise<VirtualFS> {
    const vfs = await createVfs();
    await writeSnapshot(vfs, 'sess-d-001', makeSnapshot());
    if (index !== null) await vfs.writeFile('/sessions/index.json', index);
    return vfs;
  }
  const kept = (vfs: VirtualFS) =>
    vfs.stat('/sessions/data/sess-d-001').then(
      () => true,
      () => false
    );

  it('keeps the bundle while a row still carries the sessionId', async () => {
    const vfs = await seeded(
      JSON.stringify([
        { filename: 'a.md', title: 'a', frozenAt: 'x', messageCount: 1, sessionId: 'sess-d-001' },
      ])
    );
    expect(await discardSnapshotIfUnindexed(vfs, 'sess-d-001')).toBe(false);
    expect(await kept(vfs)).toBe(true);
  });

  it('removes the bundle when a well-formed index no longer has the row', async () => {
    const vfs = await seeded('[]');
    expect(await discardSnapshotIfUnindexed(vfs, 'sess-d-001')).toBe(true);
    expect(await kept(vfs)).toBe(false);
  });

  it('keeps the bundle when the index is missing or corrupt — it cannot prove a delete', async () => {
    for (const index of [null, '[{"filename": trunc']) {
      const vfs = await seeded(index);
      expect(await discardSnapshotIfUnindexed(vfs, 'sess-d-001')).toBe(false);
      expect(await kept(vfs)).toBe(true);
    }
  });
});
```

In `packages/webapp/tests/transcript/export-service.test.ts`, inside `describe('DefaultTranscriptExportService — captureFrozen', ...)`, add:

```ts
it('drops the bundle again when its session was deleted while the capture ran', async () => {
  const snapshotStore = {
    ...makeEmptySnapshotStore(),
    discardIfUnindexed: vi.fn(async (_id: string) => true),
  };
  const svc = new DefaultTranscriptExportService(makeDeps({ snapshotStore }));

  await svc.captureFrozen({
    sessionId: 'sess-freeze-002',
    title: 'Frozen Title',
    frozenAt: '2024-06-01T12:00:00.000Z',
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  expect(snapshotStore.discardIfUnindexed).toHaveBeenCalledWith('sess-freeze-002');
  expect(snapshotStore.write.mock.invocationCallOrder[0]).toBeLessThan(
    snapshotStore.discardIfUnindexed.mock.invocationCallOrder[0]
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/transcript/snapshot-store.test.ts packages/webapp/tests/transcript/export-service.test.ts`
Expected: FAIL — `removeSnapshot` / `discardSnapshotIfUnindexed` not exported; `discardIfUnindexed` never called.

- [ ] **Step 3: Implement**

`packages/webapp/src/transcript/snapshot-store.ts` — append at the end of the "Write" section (after `writeSnapshot`):

```ts
/**
 * Remove a session's published snapshot and any staging dir a failed or
 * in-flight publish left. Only `ENOENT` counts as done; other faults throw.
 */
export async function removeSnapshot(vfs: WritableVfsClient, sessionId: string): Promise<void> {
  assertSafeSessionId(sessionId);
  for (const dir of [sessionDir(sessionId), tmpDir(sessionId)]) {
    try {
      await vfs.rm(dir, { recursive: true });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
    }
  }
}

/**
 * Called right after a frozen session's snapshot is published: when a
 * well-formed index has no row with this `sessionId` any more (deleted while
 * the capture ran), remove the bundle again. Runs inside the sessions-index
 * lock, so it orders after any in-flight delete. A missing or corrupt index
 * keeps the bundle — it cannot prove the session is gone.
 */
export async function discardSnapshotIfUnindexed(
  vfs: WritableVfsClient,
  sessionId: string
): Promise<boolean> {
  // Lazy: this module is on the kernel worker's first-load graph.
  const [{ serializeIndexWrite }, { readIndexForPresence }] = await Promise.all([
    import('./frozen-archive-writer.js'),
    import('./frozen-session-identity.js'),
  ]);
  return serializeIndexWrite(async () => {
    const entries = await readIndexForPresence(vfs);
    if (entries === null || entries.some((entry) => entry.sessionId === sessionId)) return false;
    await removeSnapshot(vfs, sessionId);
    return true;
  });
}
```

`packages/webapp/src/transcript/export-service.ts`:

1. In `ExportServiceDeps.snapshotStore`, after the `write(...)` member add:

```ts
    /**
     * Called after `write` for a frozen capture: drop the bundle again when
     * its session was deleted while the capture ran. Optional for callers
     * that never capture frozen sessions.
     */
    discardIfUnindexed?(sessionId: string): Promise<unknown>;
```

2. In `captureFrozen`, wrap the existing `await this.deps.snapshotStore.write(metadata.sessionId, { document: finalDoc, attachments: bundleFiles }, signal);` statement:

```ts
try {
  await this.deps.snapshotStore.write(
    metadata.sessionId,
    {
      document: finalDoc,
      attachments: bundleFiles,
    },
    signal
  );
} finally {
  // Not awaited: New chat's 5 s snapshot deadline must not wait on the
  // sessions-index lock. Runs even when a concurrent delete broke the publish.
  void this.deps.snapshotStore.discardIfUnindexed?.(metadata.sessionId)?.catch(() => undefined);
}
```

`packages/webapp/src/ui/wc/wc-live.ts`:

1. Change the import to `import { discardSnapshotIfUnindexed, readSnapshot, writeSnapshot } from '../../transcript/snapshot-store.js';`
2. In the page service's `snapshotStore: { … }` literal, after the `write` member add:

```ts
        discardIfUnindexed: async (sessionId) => {
          const { writer } = await openVfs();
          return discardSnapshotIfUnindexed(writer, sessionId);
        },
```

`packages/webapp/src/scoops/orchestrator.ts`:

1. Change the import to `import { discardSnapshotIfUnindexed, readSnapshot, writeSnapshot } from '../transcript/snapshot-store.js';`
2. In the worker service's `snapshotStore: { … }` literal, after the `write` member add:

```ts
        discardIfUnindexed: (sessionId) =>
          // SAFETY: same structural bridge as above — VirtualFS satisfies the
          // WritableVfsClient surface.
          discardSnapshotIfUnindexed(fs as unknown as WritableVfsClient, sessionId),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/transcript/snapshot-store.test.ts packages/webapp/tests/transcript/export-service.test.ts && npx biome check --write packages/webapp/src/transcript/snapshot-store.ts packages/webapp/src/transcript/export-service.ts packages/webapp/src/ui/wc/wc-live.ts packages/webapp/src/scoops/orchestrator.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; Biome clean; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/transcript/snapshot-store.ts packages/webapp/src/transcript/export-service.ts packages/webapp/src/ui/wc/wc-live.ts packages/webapp/src/scoops/orchestrator.ts packages/webapp/tests/transcript/snapshot-store.test.ts packages/webapp/tests/transcript/export-service.test.ts
git commit -m "feat(webapp): remove frozen snapshots, and discard one published after a delete

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Search index — strict invalidation and persist-if-current

**Files:**

- Modify: `packages/webapp/src/transcript/session-search-index.ts` (`rebuildSessionSearchIndex` ~line 288, `ensureSessionSearchIndex` ~line 316, `invalidateSessionSearchIndex` ~line 521)
- Test: `packages/webapp/tests/transcript/session-search.test.ts`

**Interfaces:**

- Produces: `invalidateSessionSearchIndex(vfs: { rm(path: string): Promise<void> }, options?: { strict?: boolean }): Promise<void>`; `rebuildSessionSearchIndex(vfs)` returns `{ docs: number; archives: number; written: boolean }`.

- [ ] **Step 1: Write the failing tests** — in `packages/webapp/tests/transcript/session-search.test.ts` add `invalidateSessionSearchIndex` to the `session-search-index.js` import, then append:

```ts
describe('search index vs a delete', () => {
  it('strict invalidation ignores only ENOENT; the default stays lenient', async () => {
    const failing = (code: string) => ({
      rm: async () => {
        throw Object.assign(new Error(`${code}: x`), { code });
      },
    });
    await expect(
      invalidateSessionSearchIndex(failing('ENOENT'), { strict: true })
    ).resolves.toBeUndefined();
    await expect(invalidateSessionSearchIndex(failing('EIO'), { strict: true })).rejects.toThrow(
      'EIO'
    );
    await expect(invalidateSessionSearchIndex(failing('EIO'))).resolves.toBeUndefined();
  });

  it('skips persisting a rebuild when the sessions changed while it read them', async () => {
    const fs = await VirtualFS.create({ dbName: `search-persist-${Math.random()}`, wipe: true });
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const filename = '2026-01-01T00-00-00-000Z-zebra.md';
    await fs.writeFile(
      `${SESSIONS_DIR}/${filename}`,
      formatArchiveAsMarkdown({
        id: 's1',
        title: 'Zebra',
        frozenAt: '2026-01-01T00:00:00.000Z',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        messages: [msg('user', 'zebra fact', 'u1')],
      })
    );
    const indexJson = JSON.stringify([
      {
        filename,
        title: 'Zebra',
        frozenAt: '2026-01-01T00:00:00.000Z',
        messageCount: 1,
        sessionId: 's1',
      },
    ]);
    await fs.writeFile(`${SESSIONS_DIR}/index.json`, indexJson);

    let deleted = false;
    const racing = {
      readFile: async (path: string, options?: { encoding?: string }) => {
        const out = await fs.readFile(path, options as never);
        if (path === `${SESSIONS_DIR}/${filename}` && !deleted) {
          deleted = true;
          await fs.writeFile(`${SESSIONS_DIR}/index.json`, '[]');
        }
        return out;
      },
      writeFile: (path: string, content: string) => fs.writeFile(path, content),
      readDir: (path: string) => fs.readDir(path),
    };

    const built = await rebuildSessionSearchIndex(racing);
    expect(deleted).toBe(true);
    expect(built.written).toBe(false);
    await expect(fs.stat(`${SESSIONS_DIR}/.search-index.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Unchanged sessions persist as before.
    await fs.writeFile(`${SESSIONS_DIR}/index.json`, indexJson);
    expect((await rebuildSessionSearchIndex(fs)).written).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/transcript/session-search.test.ts -t "vs a delete"`
Expected: FAIL — `strict` is ignored (EIO swallowed); `written` is undefined and the stale index is written.

- [ ] **Step 3: Implement** — in `packages/webapp/src/transcript/session-search-index.ts`:

1. Replace `rebuildSessionSearchIndex` with a build step, a guarded persist step, and the public wrapper:

```ts
interface BuiltSearchIndex {
  mini: MiniSearchLike;
  meta: IndexMeta;
  docs: number;
  archives: number;
}

async function buildSessionSearchIndex(vfs: SessionSearchVfs): Promise<BuiltSearchIndex> {
  const MiniSearch = (await import('minisearch')).default as unknown as MiniSearchCtor;
  const located = await collectLocatedEntries(vfs);
  const docs: SessionSearchDoc[] = [];
  // MiniSearch throws on a duplicate id; a sessionId shared between a cone
  // archive and a scoop snapshot must degrade to "first dir wins", not fail
  // the whole rebuild.
  const seen = new Set<string>();
  for (const { entry, sessionsDir } of located) {
    for (const doc of await docsForEntry(vfs, entry, sessionsDir)) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      docs.push(doc);
    }
  }
  const mini = new MiniSearch(INDEX_OPTIONS);
  if (docs.length) mini.addAll(docs);
  const meta: IndexMeta = {
    version: 1,
    builtAt: Date.now(),
    archiveCount: located.length,
    fingerprint: fingerprintLocatedEntries(located),
  };
  return { mini, meta, docs: docs.length, archives: located.length };
}

/**
 * Persist a built index only if the sessions it read are still the current
 * ones: a delete (or freeze) landing mid-build would otherwise be overwritten
 * by an index still holding the deleted bodies. A skipped write is rebuilt
 * by the next search (fingerprint mismatch).
 */
async function persistIfCurrent(vfs: SessionSearchVfs, built: BuiltSearchIndex): Promise<boolean> {
  const current = fingerprintLocatedEntries(await collectLocatedEntries(vfs));
  if (current !== built.meta.fingerprint) return false;
  await vfs.writeFile(
    SESSION_SEARCH_INDEX_PATH,
    JSON.stringify({ meta: built.meta, index: built.mini.toJSON() })
  );
  return true;
}

export async function rebuildSessionSearchIndex(vfs: SessionSearchVfs): Promise<{
  docs: number;
  archives: number;
  written: boolean;
}> {
  const built = await buildSessionSearchIndex(vfs);
  const written = await persistIfCurrent(vfs, built);
  return { docs: built.docs, archives: built.archives, written };
}
```

2. In `ensureSessionSearchIndex`, replace everything after the `catch { // Missing or corrupt — rebuild below. }` block (from `await rebuildSessionSearchIndex(vfs);` to the function's closing `loadJS(...)` return) with:

```ts
const built = await buildSessionSearchIndex(vfs);
await persistIfCurrent(vfs, built);
return built.mini;
```

3. Replace `invalidateSessionSearchIndex` with:

```ts
/**
 * Drop the persisted index so erased archives cannot be recovered from it.
 * `strict` (frozen-session delete) rethrows anything but ENOENT so the caller
 * can keep its row for a retry; the default stays best-effort.
 */
export async function invalidateSessionSearchIndex(
  vfs: { rm(path: string): Promise<void> },
  options: { strict?: boolean } = {}
): Promise<void> {
  try {
    await vfs.rm(SESSION_SEARCH_INDEX_PATH);
  } catch (err) {
    if (options.strict && (err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/transcript/session-search.test.ts packages/webapp/tests/scoops/live-session-snapshot.test.ts packages/webapp/tests/shell/supplemental-commands/session && npx biome check --write packages/webapp/src/transcript/session-search-index.ts`
Expected: PASS; Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/transcript/session-search-index.ts packages/webapp/tests/transcript/session-search.test.ts
git commit -m "fix(webapp): session search never re-persists bodies a delete removed

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: `deleteFrozenSession` — files first, row last

**Files:**

- Create: `packages/webapp/src/ui/frozen-session-delete.ts`
- Modify: `packages/webapp/src/scoops/live-session-curation.ts:52` (export `LIVE_DELTA_DIR`)
- Test: `packages/webapp/tests/ui/frozen-session-delete.test.ts`

**Interfaces:**

- Consumes: Task 1 (`FrozenSessionKey`, `findFrozenRow`, `isSafeArchiveFilename`, `isSafeSessionKey`, `readIndexForPresence`, `trustedSessionId`); Task 2 (`sessionId` on archives); Task 5 (`removeSnapshot`); Task 6 (`invalidateSessionSearchIndex(vfs, { strict: true })`); `curatorReceiptPath`, `curationDirPath` (`scoops/agentic-memory.ts`); `loadFrozenArchive`, `sidecarPathForArchive` (`transcript/session-jsonl.ts`); `serializeIndexWrite`, `readSessionsIndexForWrite`, `writeSessionsIndexUnlocked` (`transcript/frozen-archive-writer.ts`).
- Produces (used by Tasks 8 and 10):

```ts
export type DeleteFrozenSessionResult =
  | { status: 'deleted' }
  | { status: 'not-found' | 'live' | 'unsafe' }
  | { status: 'failed'; errors: string[] };
export type FrozenRowPresence =
  | { kind: 'present'; row: FrozenSessionIndexEntry }
  | { kind: 'absent'; entries: readonly FrozenSessionIndexEntry[] }
  | { kind: 'unknown' };
export function deleteFrozenSession(
  vfs: WritableVfsClient,
  key: FrozenSessionKey
): Promise<DeleteFrozenSessionResult>;
export function findIndexedFrozenRow(
  vfs: WritableVfsClient,
  key: FrozenSessionKey
): Promise<FrozenRowPresence>;
export function removeFrozenSessionArtifacts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]>;
export function removeCuratorByproducts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]>;
```

- [ ] **Step 1: Write the failing test** — create `packages/webapp/tests/ui/frozen-session-delete.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { WritableVfsClient } from '../../src/kernel/writable-vfs-client.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import type { FrozenSessionIndexEntry } from '../../src/transcript/frozen-archive-format.js';
import { formatArchiveAsMarkdown } from '../../src/transcript/frozen-archive-writer.js';
import {
  deleteFrozenSession,
  findIndexedFrozenRow,
  removeCuratorByproducts,
} from '../../src/ui/frozen-session-delete.js';

let dbCounter = 0;
let vfs: VirtualFS;
const w = (): WritableVfsClient => vfs as unknown as WritableVfsClient;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `frozen-session-delete-${dbCounter++}`, wipe: true });
});

async function put(path: string, content: string): Promise<void> {
  await vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.writeFile(path, content);
}

const exists = (path: string): Promise<boolean> =>
  vfs.stat(path).then(
    () => true,
    () => false
  );

async function index(): Promise<FrozenSessionIndexEntry[]> {
  return JSON.parse((await vfs.readFile('/sessions/index.json', { encoding: 'utf-8' })) as string);
}

function row(
  filename: string,
  sessionId?: string,
  extra: Partial<FrozenSessionIndexEntry> = {}
): FrozenSessionIndexEntry {
  return {
    filename,
    title: filename,
    frozenAt: '2026-06-01T10:00:00.000Z',
    messageCount: 2,
    ...(sessionId ? { sessionId } : {}),
    ...extra,
  };
}

/** Write every file a frozen session can own; returns their paths (archive first). */
async function seedSession(
  entry: FrozenSessionIndexEntry,
  attachmentKey = entry.filename.slice(0, -3)
): Promise<string[]> {
  const attachmentPath = `/sessions/attachments/${attachmentKey}/0-shot.png`;
  const messages: ChatMessage[] = [
    {
      id: 'u1',
      role: 'user',
      content: 'fix the build',
      timestamp: 1,
      attachments: [
        {
          id: 'a1',
          name: 'shot.png',
          mimeType: 'image/png',
          size: 3,
          kind: 'file',
          path: attachmentPath,
        },
      ],
    },
    { id: 'a2', role: 'assistant', content: 'done', timestamp: 2 },
  ];
  const archive = `/sessions/${entry.filename}`;
  const owned = [
    archive,
    `/sessions/${entry.filename.slice(0, -3)}.jsonl`,
    attachmentPath,
    `/sessions/.curated/${entry.filename}`,
    `/sessions/.curation/${entry.filename}/status.json`,
  ];
  if (entry.sessionId) {
    owned.push(
      `/sessions/data/${entry.sessionId}/document.json`,
      `/sessions/data/.tmp-${entry.sessionId}/document.json`,
      `/sessions/.live-deltas/${entry.sessionId}-0-5.md`,
      `/sessions/.curated/${entry.sessionId}-0-5.md`,
      `/sessions/.curation/${entry.sessionId}-0-5.md/status.json`
    );
  }
  for (const path of owned.slice(1)) await put(path, 'x');
  await put(
    archive,
    formatArchiveAsMarkdown({
      id: 'session-cone',
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      title: entry.title,
      frozenAt: entry.frozenAt,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      messages,
    })
  );
  return owned;
}

describe('deleteFrozenSession', () => {
  it('removes every file the session owns, then its row; a sibling is untouched', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    const b = row('2026-06-02T10-00-00-000Z-b.md', 'sid-b');
    // A's attachments were persisted under its pre-rename draft name.
    const ownedA = await seedSession(a, 'pending-aaa111');
    const ownedB = await seedSession(b);
    await put('/sessions/index.json', JSON.stringify([b, a]));
    await put('/sessions/.search-index.json', '{}');

    expect(await deleteFrozenSession(w(), { filename: a.filename, sessionId: 'sid-a' })).toEqual({
      status: 'deleted',
    });

    for (const path of ownedA) expect(await exists(path), path).toBe(false);
    for (const dir of ['/sessions/attachments/pending-aaa111', '/sessions/data/sid-a']) {
      expect(await exists(dir), dir).toBe(false);
    }
    for (const path of ownedB) expect(await exists(path), path).toBe(true);
    expect((await index()).map((e) => e.filename)).toEqual([b.filename]);
    expect(await exists('/sessions/.search-index.json')).toBe(false);
  });

  it('refuses a live row and touches nothing', async () => {
    const live = row('live-cone-x1.md', 'sid-l', { live: true });
    const owned = await seedSession(live);
    await put('/sessions/index.json', JSON.stringify([live]));

    expect(await deleteFrozenSession(w(), { filename: live.filename })).toEqual({ status: 'live' });
    for (const path of owned) expect(await exists(path), path).toBe(true);
    expect(await index()).toHaveLength(1);
  });

  it('refuses a row whose filename escapes /sessions', async () => {
    await put('/shared/CLAUDE.md', 'precious');
    const evil = row('../shared/CLAUDE.md', 'sid-e');
    await put('/sessions/index.json', JSON.stringify([evil]));

    expect(await deleteFrozenSession(w(), { filename: evil.filename })).toEqual({
      status: 'unsafe',
    });
    expect(await exists('/shared/CLAUDE.md')).toBe(true);
    expect(await index()).toHaveLength(1);
  });

  it('reports not-found for an unknown key', async () => {
    await put('/sessions/index.json', JSON.stringify([row('a.md', 'sid-a')]));
    expect(await deleteFrozenSession(w(), { filename: 'gone.md' })).toEqual({
      status: 'not-found',
    });
  });

  it('follows an enrichment rename through the unique sessionId', async () => {
    const renamed = row('2026-06-01T10-00-00-000Z-real-title.md', 'sid-r');
    await seedSession(renamed);
    await put('/sessions/index.json', JSON.stringify([renamed]));

    expect(
      await deleteFrozenSession(w(), { filename: 'pending-r1.md', sessionId: 'sid-r' })
    ).toEqual({ status: 'deleted' });
    expect(await index()).toEqual([]);
    expect(await exists(`/sessions/${renamed.filename}`)).toBe(false);
  });

  it('never derives paths from a sessionId two rows share (#3807)', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'session-cone');
    const b = row('2026-06-02T10-00-00-000Z-b.md', 'session-cone');
    await seedSession(a);
    await put('/sessions/index.json', JSON.stringify([b, a]));

    expect(await deleteFrozenSession(w(), { filename: a.filename })).toEqual({ status: 'deleted' });
    expect(await exists(`/sessions/${a.filename}`)).toBe(false);
    expect(await exists('/sessions/data/session-cone/document.json')).toBe(true);
    expect(await exists('/sessions/.live-deltas/session-cone-0-5.md')).toBe(true);
    expect((await index()).map((e) => e.filename)).toEqual([b.filename]);
  });

  it('treats files already gone as done', async () => {
    const bare = row('2026-06-01T10-00-00-000Z-bare.md', 'sid-bare');
    await put('/sessions/index.json', JSON.stringify([bare]));
    expect(await deleteFrozenSession(w(), { filename: bare.filename })).toEqual({
      status: 'deleted',
    });
    expect(await index()).toEqual([]);
  });

  it('keeps the row when a removal fails, so a retry can finish the job', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    await seedSession(a);
    await put('/sessions/index.json', JSON.stringify([a]));
    const flaky = new Proxy(vfs, {
      get(target, prop) {
        if (prop === 'rm') {
          return async (path: string, options?: { recursive?: boolean }) => {
            if (path === `/sessions/${a.filename}`) {
              throw Object.assign(new Error('EIO: disk'), { code: 'EIO' });
            }
            return target.rm(path, options);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as WritableVfsClient;

    const failed = await deleteFrozenSession(flaky, { filename: a.filename });
    expect(failed.status).toBe('failed');
    expect(await index()).toHaveLength(1);

    expect(await deleteFrozenSession(w(), { filename: a.filename })).toEqual({ status: 'deleted' });
    expect(await index()).toEqual([]);
  });
});

describe('deleteFrozenSession — partial failure', () => {
  it('keeps the archive while an attachment dir resists, so the retry still finds it', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    await seedSession(a, 'pending-aaa111');
    await put('/sessions/index.json', JSON.stringify([a]));
    const flaky = new Proxy(vfs, {
      get(target, prop) {
        if (prop === 'rm') {
          return async (path: string, options?: { recursive?: boolean }) => {
            if (path === '/sessions/attachments/pending-aaa111') {
              throw Object.assign(new Error('EIO: disk'), { code: 'EIO' });
            }
            return target.rm(path, options);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as WritableVfsClient;

    expect((await deleteFrozenSession(flaky, { filename: a.filename })).status).toBe('failed');
    expect(await exists(`/sessions/${a.filename}`)).toBe(true);
    expect(await exists('/sessions/attachments/pending-aaa111/0-shot.png')).toBe(true);

    expect(await deleteFrozenSession(w(), { filename: a.filename })).toEqual({ status: 'deleted' });
    expect(await exists('/sessions/attachments/pending-aaa111')).toBe(false);
    expect(await exists(`/sessions/${a.filename}`)).toBe(false);
  });
});

describe('findIndexedFrozenRow', () => {
  it('present / absent from a well-formed index; unknown when it cannot say', async () => {
    const a = row('a.md', 'sid-a');
    expect(await findIndexedFrozenRow(w(), { filename: 'a.md' })).toEqual({ kind: 'unknown' });
    await put('/sessions/index.json', JSON.stringify([a]));
    expect(await findIndexedFrozenRow(w(), { filename: 'a.md' })).toEqual({
      kind: 'present',
      row: a,
    });
    expect(await findIndexedFrozenRow(w(), { filename: 'b.md' })).toEqual({
      kind: 'absent',
      entries: [a],
    });
    await put('/sessions/index.json', '[{"filename": trunc');
    expect(await findIndexedFrozenRow(w(), { filename: 'a.md' })).toEqual({ kind: 'unknown' });
  });
});

describe('removeCuratorByproducts', () => {
  it('sweeps deltas, receipts and per-pass state but never the archive', async () => {
    const a = row('2026-06-01T10-00-00-000Z-a.md', 'sid-a');
    await seedSession(a);

    expect(await removeCuratorByproducts(w(), a, [])).toEqual([]);
    expect(await exists(`/sessions/${a.filename}`)).toBe(true);
    for (const path of [
      '/sessions/.live-deltas/sid-a-0-5.md',
      '/sessions/.curated/sid-a-0-5.md',
      '/sessions/.curation/sid-a-0-5.md',
      `/sessions/.curated/${a.filename}`,
      `/sessions/.curation/${a.filename}`,
    ]) {
      expect(await exists(path), path).toBe(false);
    }
  });

  it("finds a legacy row's deltas under its archive base", async () => {
    const legacy = row('2026-06-01T10-00-00-000Z-old.md');
    await put('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-0-5.md', 'x');
    await put('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-x-0-5.md', 'other session');

    expect(await removeCuratorByproducts(w(), legacy, [])).toEqual([]);
    expect(await exists('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-0-5.md')).toBe(false);
    expect(await exists('/sessions/.live-deltas/2026-06-01T10-00-00-000Z-old-x-0-5.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/frozen-session-delete.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/frozen-session-delete.js`.

- [ ] **Step 3: Implement**

In `packages/webapp/src/scoops/live-session-curation.ts` change `const LIVE_DELTA_DIR = '/sessions/.live-deltas';` to:

```ts
/** Where incremental curation writes its mined slices (`<key>-<from>-<to>.md`). */
export const LIVE_DELTA_DIR = '/sessions/.live-deltas';
```

Create `packages/webapp/src/ui/frozen-session-delete.ts`:

```ts
/**
 * Delete one frozen session from the Freezer: every file it owns, then its
 * index row, as ONE `/sessions/index.json` transaction.
 *
 * Files go first and the row LAST. An interrupted or partly failed delete
 * leaves the card in the rail — delete again; every step treats "already
 * gone" as done — instead of orphan archives a later corrupt-index rebuild
 * would turn back into sessions. Live rows are refused: the open chat is
 * discarded through New chat → Discard, which the kernel orders with the
 * snapshot writer. Extracted memories are kept; they carry no per-session
 * provenance.
 */

import { createLogger } from '../base/logger.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';
import { curationDirPath, curatorReceiptPath } from '../scoops/agentic-memory.js';
import { LIVE_DELTA_DIR } from '../scoops/live-session-curation.js';
import { type FrozenSessionIndexEntry, SESSIONS_DIR } from '../transcript/frozen-archive-format.js';
import {
  readSessionsIndexForWrite,
  serializeIndexWrite,
  writeSessionsIndexUnlocked,
} from '../transcript/frozen-archive-writer.js';
import {
  type FrozenSessionKey,
  findFrozenRow,
  isSafeArchiveFilename,
  isSafeSessionKey,
  readIndexForPresence,
  trustedSessionId,
} from '../transcript/frozen-session-identity.js';
import { loadFrozenArchive, sidecarPathForArchive } from '../transcript/session-jsonl.js';
import { invalidateSessionSearchIndex } from '../transcript/session-search-index.js';
import { removeSnapshot } from '../transcript/snapshot-store.js';

const log = createLogger('frozen-session-delete');

export type DeleteFrozenSessionResult =
  | { status: 'deleted' }
  | { status: 'not-found' | 'live' | 'unsafe' }
  | { status: 'failed'; errors: string[] };

/** What the index says about one frozen session. `unknown` never means gone. */
export type FrozenRowPresence =
  | { kind: 'present'; row: FrozenSessionIndexEntry }
  | { kind: 'absent'; entries: readonly FrozenSessionIndexEntry[] }
  | { kind: 'unknown' };

const ATTACHMENTS_DIR = `${SESSIONS_DIR}/attachments`;
const ATTACHMENT_PATH = /^\/sessions\/attachments\/([^/]+)\/[^/]+$/;
const DELTA_RANGE = /^\d+-\d+\.md$/;

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

function failure(path: string, err: unknown): string {
  return `${path}: ${err instanceof Error ? err.message : String(err)}`;
}

function archiveBase(filename: string): string {
  return filename.slice(0, -'.md'.length);
}

/** `rm` that counts "already gone" as done and records anything else. */
async function removeTolerant(
  vfs: WritableVfsClient,
  path: string,
  errors: string[],
  recursive = false
): Promise<void> {
  try {
    await vfs.rm(path, recursive ? { recursive: true } : undefined);
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(path, err));
  }
}

/** The key curation deltas were filed under: `sessionId || archive base`, if trusted. */
function deltaKeyOf(
  row: FrozenSessionIndexEntry,
  entries: readonly FrozenSessionIndexEntry[]
): string | undefined {
  if (!row.sessionId) return archiveBase(row.filename);
  return trustedSessionId(entries, row);
}

async function deltaArchivesOf(
  vfs: WritableVfsClient,
  key: string,
  errors: string[]
): Promise<string[]> {
  let names: string[];
  try {
    names = (await vfs.readDir(LIVE_DELTA_DIR)).map((entry) => entry.name);
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(LIVE_DELTA_DIR, err));
    return [];
  }
  const prefix = `${key}-`;
  return names
    .filter((name) => name.startsWith(prefix) && DELTA_RANGE.test(name.slice(prefix.length)))
    .map((name) => `${LIVE_DELTA_DIR}/${name}`);
}

/**
 * The curator's per-session leftovers: delta archives with their receipts
 * and per-pass state, plus the archive's own receipt and state — never the
 * archive itself. Also run after a curator that outlived a delete of its
 * session. `others` is the rest of the index (for `sessionId` trust).
 */
export async function removeCuratorByproducts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]> {
  if (!isSafeArchiveFilename(row.filename)) return [`unsafe archive name: ${String(row.filename)}`];
  const errors: string[] = [];
  const key = deltaKeyOf(row, [...others, row]);
  const deltas = key ? await deltaArchivesOf(vfs, key, errors) : [];
  for (const delta of deltas) await removeTolerant(vfs, delta, errors);
  for (const mined of [...deltas, `${SESSIONS_DIR}/${row.filename}`]) {
    await removeTolerant(vfs, curatorReceiptPath(mined), errors);
    await removeTolerant(vfs, curationDirPath(mined), errors, true);
  }
  return errors;
}

/** `/sessions/attachments/<key>/` dirs the archive's messages point into, plus its own base. */
async function attachmentDirsOf(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  errors: string[]
): Promise<string[]> {
  const dirs = new Set([`${ATTACHMENTS_DIR}/${archiveBase(row.filename)}`]);
  const path = `${SESSIONS_DIR}/${row.filename}`;
  try {
    const raw = await vfs.readFile(path, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const { messages } = await loadFrozenArchive(vfs, text, row.filename);
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        const key = ATTACHMENT_PATH.exec(attachment.path ?? '')?.[1];
        if (isSafeSessionKey(key)) dirs.add(`${ATTACHMENTS_DIR}/${key}`);
      }
    }
  } catch (err) {
    if (!isEnoent(err)) errors.push(failure(path, err));
  }
  return [...dirs];
}

/**
 * Remove every file one frozen session owns except its index row. `others`
 * is the rest of the index: a `sessionId` another row shares is never used
 * to derive a path (#3807). Returns the failures; "already gone" is not one.
 */
export async function removeFrozenSessionArtifacts(
  vfs: WritableVfsClient,
  row: FrozenSessionIndexEntry,
  others: readonly FrozenSessionIndexEntry[]
): Promise<string[]> {
  if (!isSafeArchiveFilename(row.filename)) return [`unsafe archive name: ${String(row.filename)}`];
  const errors: string[] = [];
  // Read the archive for its attachment dirs BEFORE anything is removed.
  const attachmentDirs = await attachmentDirsOf(vfs, row, errors);
  const sessionId = trustedSessionId([...others, row], row);
  if (sessionId) {
    try {
      await removeSnapshot(vfs, sessionId);
    } catch (err) {
      errors.push(failure(`${SESSIONS_DIR}/data/${sessionId}`, err));
    }
  }
  errors.push(...(await removeCuratorByproducts(vfs, row, others)));
  for (const dir of attachmentDirs) await removeTolerant(vfs, dir, errors, true);
  // The archive (and its sidecar) is the only record of a pre-rename
  // attachment dir: keep both until everything else is gone, so a retry can
  // still rediscover what is left.
  if (errors.length > 0) return errors;
  await removeTolerant(vfs, sidecarPathForArchive(row.filename), errors);
  await removeTolerant(vfs, `${SESSIONS_DIR}/${row.filename}`, errors);
  return errors;
}

/** Ask the index, inside its lock, whether a frozen session still exists. */
export function findIndexedFrozenRow(
  vfs: WritableVfsClient,
  key: FrozenSessionKey
): Promise<FrozenRowPresence> {
  return serializeIndexWrite(async (): Promise<FrozenRowPresence> => {
    const entries = await readIndexForPresence(vfs);
    if (entries === null) return { kind: 'unknown' };
    const row = findFrozenRow(entries, key);
    return row ? { kind: 'present', row } : { kind: 'absent', entries };
  });
}

/** Delete one frozen session (see the module doc for the ordering contract). */
export function deleteFrozenSession(
  vfs: WritableVfsClient,
  key: FrozenSessionKey
): Promise<DeleteFrozenSessionResult> {
  return serializeIndexWrite(async (): Promise<DeleteFrozenSessionResult> => {
    const entries = await readSessionsIndexForWrite(vfs);
    const row = findFrozenRow(entries, key);
    if (!row) return { status: 'not-found' };
    if (row.live) return { status: 'live' };
    if (!isSafeArchiveFilename(row.filename)) return { status: 'unsafe' };
    const others = entries.filter((entry) => entry !== row);
    const errors = await removeFrozenSessionArtifacts(vfs, row, others);
    try {
      await invalidateSessionSearchIndex(vfs, { strict: true });
    } catch (err) {
      errors.push(failure('/sessions/.search-index.json', err));
    }
    if (errors.length > 0) {
      log.warn('Frozen session delete incomplete — row kept for a retry', {
        filename: row.filename,
        errors,
      });
      return { status: 'failed', errors };
    }
    await writeSessionsIndexUnlocked(vfs, others);
    // Again, leniently: a search rebuild that read the bodies before this
    // delete may have passed its fingerprint check and written them back.
    await invalidateSessionSearchIndex(vfs);
    try {
      await vfs.flush();
    } catch {
      // Best-effort — the store persists on its own debounce.
    }
    log.info('Frozen session deleted', { filename: row.filename });
    return { status: 'deleted' };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/frozen-session-delete.test.ts packages/webapp/tests/scoops/live-session-curation.test.ts && npx biome check --write packages/webapp/src/ui/frozen-session-delete.ts packages/webapp/src/scoops/live-session-curation.ts packages/webapp/tests/ui/frozen-session-delete.test.ts && node packages/dev-tools/tools/check-layer-back-edges.mjs`
Expected: PASS; Biome clean; no new layer back-edges.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/frozen-session-delete.ts packages/webapp/src/scoops/live-session-curation.ts packages/webapp/tests/ui/frozen-session-delete.test.ts
git commit -m "feat(webapp): delete a frozen session — every file first, its index row last

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: The post-freeze pipeline stops for a deleted session

**Files:**

- Modify: `packages/webapp/src/ui/new-session.ts` (`runAgenticBackgroundPass` ~line 159; legacy timer branch ~line 505)
- Test: `packages/webapp/tests/ui/new-session.test.ts`

**Interfaces:**

- Consumes: `findIndexedFrozenRow`, `removeCuratorByproducts` (Task 7).
- Produces: nothing public.

- [ ] **Step 1: Write the failing tests** — in `packages/webapp/tests/ui/new-session.test.ts`:

1. Next to the other `vi.mock` calls (before the `new-session.js` import) add:

```ts
const mockFindIndexedFrozenRow = vi.fn();
const mockRemoveCuratorByproducts = vi.fn();
vi.mock('../../src/ui/frozen-session-delete.js', () => ({
  findIndexedFrozenRow: (...a: unknown[]) => mockFindIndexedFrozenRow(...a),
  removeCuratorByproducts: (...a: unknown[]) => mockRemoveCuratorByproducts(...a),
}));
```

2. In the top-level `beforeEach` add (default: the index cannot say → today's behavior):

```ts
mockFindIndexedFrozenRow.mockReset().mockResolvedValue({ kind: 'unknown' });
mockRemoveCuratorByproducts.mockReset().mockResolvedValue([]);
```

3. Inside `describe('runNewSessionFreeze — write-first + race', ...)` add:

```ts
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

it('agentic background pass skips the curator for a session deleted after the freeze', async () => {
  mockIsFeatureEnabled.mockReturnValue(true);
  mockFreezeConeSession.mockResolvedValue({ ...pending, memoryPending: true as const });
  mockEnrichPendingSession.mockResolvedValue(null);
  mockFindIndexedFrozenRow.mockResolvedValue({ kind: 'absent', entries: [] });
  const onSessionSettled = vi.fn();

  await runNewSessionFreeze({ vfs: {} as never, agenticMemorySpawn: vi.fn(), onSessionSettled });
  await vi.waitFor(() => expect(mockFindIndexedFrozenRow).toHaveBeenCalled());
  await settle();

  expect(mockCurateFrozenSessionMemories).not.toHaveBeenCalled();
  expect(onSessionSettled).not.toHaveBeenCalled();
});

it('agentic pass curates the row a rival enrichment renamed', async () => {
  mockIsFeatureEnabled.mockReturnValue(true);
  mockFreezeConeSession.mockResolvedValue({ ...pending, memoryPending: true as const });
  mockEnrichPendingSession.mockResolvedValue(null);
  mockFindIndexedFrozenRow.mockResolvedValue({ kind: 'present', row: enriched });
  mockCurateFrozenSessionMemories.mockResolvedValue(null);

  await runNewSessionFreeze({ vfs: {} as never, agenticMemorySpawn: vi.fn() });
  await vi.waitFor(() => expect(mockCurateFrozenSessionMemories).toHaveBeenCalledOnce());

  const target = mockCurateFrozenSessionMemories.mock.calls[0][1] as FrozenSession;
  expect(target.filename).toBe(enriched.filename);
});

it('a delete landing while the curator ran sweeps its leftovers and settles nothing', async () => {
  mockIsFeatureEnabled.mockReturnValue(true);
  mockFreezeConeSession.mockResolvedValue({ ...pending, memoryPending: true as const });
  mockEnrichPendingSession.mockResolvedValue(null);
  mockFindIndexedFrozenRow
    .mockResolvedValueOnce({ kind: 'present', row: pending })
    .mockResolvedValueOnce({ kind: 'absent', entries: [] });
  mockCurateFrozenSessionMemories.mockResolvedValue(null);
  const onSessionSettled = vi.fn();
  const onBackgroundEnriched = vi.fn();

  await runNewSessionFreeze({
    vfs: {} as never,
    agenticMemorySpawn: vi.fn(),
    onSessionSettled,
    onBackgroundEnriched,
  });
  await vi.waitFor(() => expect(mockRemoveCuratorByproducts).toHaveBeenCalledOnce());
  await settle();

  expect(mockRemoveCuratorByproducts).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ filename: pending.filename }),
    []
  );
  expect(onSessionSettled).not.toHaveBeenCalled();
  expect(onBackgroundEnriched).not.toHaveBeenCalled();
});

it('legacy background enrichment does not settle a session deleted meanwhile', async () => {
  const enrich = deferred<FrozenSessionIndexEntry | null>();
  mockEnrichPendingSession.mockReturnValue(enrich.promise);
  mockFindIndexedFrozenRow.mockResolvedValue({ kind: 'absent', entries: [] });
  const onSessionSettled = vi.fn();

  await runNewSessionFreeze({ vfs: {} as never, enrichmentRaceMs: 5, onSessionSettled });
  enrich.resolve(null);
  await vi.waitFor(() => expect(mockFindIndexedFrozenRow).toHaveBeenCalled());
  await settle();

  expect(onSessionSettled).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/new-session.test.ts`
Expected: the four new tests FAIL (curator runs, settles fire, `findIndexedFrozenRow` never called); all existing tests PASS.

- [ ] **Step 3: Implement** — in `packages/webapp/src/ui/new-session.ts`:

1. Add the import (`npx biome check --write` sorts it into place):

```ts
import { findIndexedFrozenRow, removeCuratorByproducts } from './frozen-session-delete.js';
```

2. Add two module-level helpers directly above `runAgenticBackgroundPass`'s doc comment:

```ts
/**
 * `current` re-pointed at its index row (a rival enrichment may have renamed
 * it), or `null` when the index says the user deleted it. An index that
 * cannot say (`unknown`) keeps today's behavior.
 */
async function stillFrozen(
  vfs: WritableVfsClient,
  current: FrozenSession
): Promise<FrozenSession | null> {
  const presence = await findIndexedFrozenRow(vfs, current);
  if (presence.kind === 'absent') return null;
  if (presence.kind === 'present' && presence.row.filename !== current.filename) {
    return { ...current, filename: presence.row.filename };
  }
  return current;
}

/** A curator that outlived a delete of its session: sweep what it left behind. */
async function sweepIfDeleted(vfs: WritableVfsClient, current: FrozenSession): Promise<boolean> {
  const presence = await findIndexedFrozenRow(vfs, current);
  if (presence.kind !== 'absent') return false;
  const errors = await removeCuratorByproducts(vfs, current, presence.entries);
  if (errors.length > 0) {
    log.warn('Curator leftovers of a deleted session not fully removed', {
      filename: current.filename,
      errors,
    });
  }
  return true;
}
```

3. In `runAgenticBackgroundPass`, immediately before `const curated = await curateFrozenSessionMemories(` insert:

```ts
const target = await stillFrozen(opts.vfs, current);
if (!target) {
  log.info('Frozen session deleted before curation — curator skipped', {
    filename: current.filename,
  });
  return;
}
current = target;
```

and replace the function's last two statements

```ts
  opts.onBackgroundEnriched?.(curated);
  opts.onSessionSettled?.(curated ?? current);
}
```

with

```ts
  if (await sweepIfDeleted(opts.vfs, current)) return;
  opts.onBackgroundEnriched?.(curated);
  opts.onSessionSettled?.(curated ?? current);
}
```

4. In the legacy path replace

```ts
  void enrichment.then((updated) => {
```

with `void enrichment.then(async (updated) => {`, and inside that callback replace

```ts
    opts.onBackgroundEnriched?.(updated);
    opts.onSessionSettled?.(updated ?? frozen);
  });
```

with

```ts
    opts.onBackgroundEnriched?.(updated);
    const settled = updated ?? frozen;
    // Deleted while enrichment ran: nothing to tell the gelatiere about.
    if ((await findIndexedFrozenRow(opts.vfs, settled)).kind === 'absent') return;
    opts.onSessionSettled?.(settled);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/new-session.test.ts packages/webapp/tests/ui/wc/wc-live-freezer-erase.test.ts packages/webapp/tests/ui/wc/wc-live-freezer-cone.test.ts && npx biome check --write packages/webapp/src/ui/new-session.ts`
Expected: PASS; Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/new-session.ts packages/webapp/tests/ui/new-session.test.ts
git commit -m "fix(webapp): skip the curator and gelatiere for a frozen session deleted meanwhile

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: `<slicc-freezer-card deletable>` trash button

**Files:**

- Modify: `packages/webcomponents/src/freezer/slicc-freezer-card.ts`
- Modify: `packages/webcomponents/src/freezer/slicc-freezer-card.stories.ts`
- Test: `packages/webcomponents/tests/freezer/slicc-freezer-card.test.ts` (real Chromium)

**Interfaces:**

- Produces: boolean attribute/property `deletable`; child `button.slicc-fzcard__delete[part="delete"]`; event `freezer-card-delete` (`bubbles`, `composed`, `detail: { slug: string }`).

- [ ] **Step 1: Write the failing tests** — inside the top-level `describe('slicc-freezer-card', ...)` of `packages/webcomponents/tests/freezer/slicc-freezer-card.test.ts` add:

```ts
describe('delete affordance (deletable)', () => {
  const deleteBtnOf = (el: SliccFreezerCard) =>
    el.querySelector<HTMLButtonElement>(':scope > .slicc-fzcard__delete');

  it('renders a labelled trash button only while deletable', () => {
    const el = makeCard({ title: 'warm hero', slug: 'warm-hero', expanded: true });
    document.body.appendChild(el);
    expect(deleteBtnOf(el)).toBeNull();

    el.deletable = true;
    expect(el.hasAttribute('deletable')).toBe(true);
    const btn = deleteBtnOf(el)!;
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('part')).toBe('delete');
    expect(btn.getAttribute('title')).toBe('Delete');
    expect(btn.getAttribute('aria-label')).toBe('Delete “warm hero”');
    expect(btn.querySelector('svg')).not.toBeNull();

    el.deletable = false;
    expect(deleteBtnOf(el)).toBeNull();
  });

  it('builds the button when deletable is set before connecting, and tracks the title', () => {
    const el = makeCard({ title: 'old', slug: 's', expanded: true });
    el.setAttribute('deletable', '');
    document.body.appendChild(el);
    expect(deleteBtnOf(el)?.getAttribute('aria-label')).toBe('Delete “old”');
    el.title = 'new';
    expect(deleteBtnOf(el)?.getAttribute('aria-label')).toBe('Delete “new”');
  });

  it('fires freezer-card-delete (composed, bubbling) and never freezer-card-select', () => {
    const el = makeCard({ title: 't', slug: 'warm-hero', expanded: true });
    el.setAttribute('deletable', '');
    document.body.appendChild(el);
    const selected = vi.fn();
    el.addEventListener('freezer-card-select', selected);
    let detail: unknown = null;
    document.body.addEventListener(
      'freezer-card-delete',
      (e) => {
        const ce = e as CustomEvent<{ slug: string }>;
        expect(ce.composed).toBe(true);
        detail = ce.detail;
      },
      { once: true }
    );

    deleteBtnOf(el)!.click();

    expect(detail).toEqual({ slug: 'warm-hero' });
    expect(selected).not.toHaveBeenCalled();
    expect(el.thawed).toBe(false);
  });

  it('is out of layout and tab order in the collapsed rail; present when expanded', () => {
    const el = makeCard({ title: 't', slug: 's' });
    el.setAttribute('deletable', '');
    document.body.appendChild(el);
    const btn = deleteBtnOf(el)!;
    expect(getComputedStyle(btn).display).toBe('none');

    el.expanded = true;
    expect(getComputedStyle(btn).display).not.toBe('none');
    expect(getComputedStyle(btn).opacity).toBe('0');
    btn.focus();
    expect(document.activeElement).toBe(btn);

    el.expanded = false;
    expect(getComputedStyle(btn).display).toBe('none');
  });

  it('survives detach + re-attach without a second button', () => {
    const el = makeCard({ title: 't', slug: 's', expanded: true });
    el.setAttribute('deletable', '');
    document.body.appendChild(el);
    el.remove();
    document.body.appendChild(el);
    expect(el.querySelectorAll('.slicc-fzcard__delete')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-freezer-card.test.ts` (first time: `npx playwright install chromium`)
Expected: the new tests FAIL (`deletable` unknown; no button).

- [ ] **Step 3: Implement** — in `packages/webcomponents/src/freezer/slicc-freezer-card.ts`:

1. Append to the `STYLE` template literal (before its closing backtick):

```css
/* Trash button (deletable rows): a quiet trailing icon that appears on row
   hover / keyboard focus. display:none in the icon-only rail takes it out of
   layout AND the tab order. */
slicc-freezer-card .slicc-fzcard__delete {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--txt-3);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s,
    background-color 0.12s,
    color 0.12s;
}
slicc-freezer-card:hover .slicc-fzcard__delete,
slicc-freezer-card:focus-within .slicc-fzcard__delete {
  opacity: 1;
}
slicc-freezer-card .slicc-fzcard__delete:hover,
slicc-freezer-card .slicc-fzcard__delete:focus-visible {
  color: var(--rose);
  background: color-mix(in srgb, var(--rose) 14%, transparent);
}
slicc-freezer-card:not([expanded]) .slicc-fzcard__delete {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  slicc-freezer-card .slicc-fzcard__delete {
    transition: none;
  }
}
```

2. Add a size constant next to `ICON_SIZE`: `const DELETE_ICON_SIZE = 14;`
3. In the class doc comment add `@attr deletable - boolean; adds a trailing trash button that fires freezer-card-delete`, `@csspart delete - the trash button`, and `@fires freezer-card-delete - composed + bubbling; detail.slug when the trash button is clicked (the row does not thaw)`.
4. `static readonly observedAttributes = ['title', 'meta', 'slug', 'icon', 'thawed', 'deletable'];`
5. Add fields after `#iconNode`:

```ts
  /** The trailing trash button while `deletable` is set. */
  #deleteBtn: HTMLButtonElement | null = null;
  #onDelete = (event: Event): void => {
    // The row's own click would thaw the session; deleting must not.
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('freezer-card-delete', {
        bubbles: true,
        composed: true,
        detail: { slug: this.slug },
      })
    );
  };
```

6. In `attributeChangedCallback`, add a branch before the final `else`: `} else if (name === 'deletable') { this.#syncDelete(); }`.
7. Add the property next to `icon`:

```ts
  /** Whether the row offers a trash button (`freezer-card-delete`). */
  get deletable(): boolean {
    return this.hasAttribute('deletable');
  }

  set deletable(value: boolean) {
    this.toggleAttribute('deletable', value);
  }
```

8. In `#build`'s re-use branch (the `if (existing instanceof HTMLElement) { … }` block), before its `return;`, add:

```ts
this.#deleteBtn = this.querySelector(':scope > .slicc-fzcard__delete');
this.#deleteBtn?.addEventListener('click', this.#onDelete);
```

9. At the end of `#sync()` (after `this.#syncIcon();`) add `this.#syncDelete();`.
10. Add the method after `#syncIcon`:

```ts
  /**
   * Reflect `deletable`: create the trailing trash button (before the hover
   * tip) or remove it, and keep its accessible name on the current title.
   */
  #syncDelete(): void {
    if (!this.#built) return;
    if (!this.hasAttribute('deletable')) {
      this.#deleteBtn?.remove();
      this.#deleteBtn = null;
      return;
    }
    if (!this.#deleteBtn) {
      const btn = h(
        'button',
        { type: 'button', class: 'slicc-fzcard__delete', part: 'delete', title: 'Delete' },
        iconEl('trash-2', { size: DELETE_ICON_SIZE })
      ) as HTMLButtonElement;
      btn.addEventListener('click', this.#onDelete);
      this.insertBefore(btn, this.#tip);
      this.#deleteBtn = btn;
    }
    const title = this.getAttribute('title') ?? this.#title.textContent ?? '';
    this.#deleteBtn.setAttribute('aria-label', `Delete “${title}”`);
  }
```

11. Stories (`slicc-freezer-card.stories.ts`): add `deletable?: boolean;` to `FreezerCardArgs`, `if (args.deletable) el.setAttribute('deletable', '');` in `makeCard`, an `argTypes` entry `deletable: { control: 'boolean', description: 'Offer a trash button (fires freezer-card-delete)' },`, and two stories:

```ts
/** Deletable — an expanded row offering delete; the trash icon appears on hover/focus. */
export const Deletable: Story = {
  args: { ...SAMPLE, expanded: true, deletable: true },
};

/** Deletable + hover — the trash button revealed (Pseudo States toolbar). */
export const DeletableHover: Story = {
  args: { ...SAMPLE, expanded: true, deletable: true },
  parameters: { pseudo: { hover: true } },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer && npm run typecheck -w @slicc/webcomponents && npx biome check --write packages/webcomponents/src/freezer && npm run lint:no-innerhtml`
Expected: PASS; typecheck clean; Biome clean; no innerHTML.

- [ ] **Step 5: Commit**

```bash
git add packages/webcomponents/src/freezer/slicc-freezer-card.ts packages/webcomponents/src/freezer/slicc-freezer-card.stories.ts packages/webcomponents/tests/freezer/slicc-freezer-card.test.ts
git commit -m "feat(webcomponents): deletable freezer cards with a trash button

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: Rail wiring — confirm dialog, delete, leave the viewed chat

**Files:**

- Create: `packages/webapp/src/ui/wc/wc-freezer-delete.ts`
- Modify: `packages/webapp/src/ui/wc/wc-cone-actions.ts` (export the dialog builder + styles)
- Modify: `packages/webapp/src/ui/wc/wc-freezer.ts` (`frozenCard` / `renderFreezerCards` options)
- Modify: `packages/webapp/src/ui/wc/wc-live-freezer.ts` (module-scope refresh helpers; wire delete)
- Test: `packages/webapp/tests/ui/wc/wc-freezer-delete.test.ts`, `packages/webapp/tests/ui/wc/wc-live-freezer-delete.test.ts`, `packages/webapp/tests/ui/wc/wc-freezer.test.ts`

**Interfaces:**

- Consumes: `deleteFrozenSession` (Task 7, dynamic import); `recoverCorruptFreezerIndex` (Task 4); card contract (Task 9).
- Produces:
  - `wc-cone-actions.ts`: `export type ConeDialog`, `export interface ConeDialogSpec`, `export function buildConeDialog`, `export const BTN_DANGER`, `export const BTN_PLAIN` (bodies unchanged; buttons carry `data-cone-action="<data>"`).
  - `wc-freezer.ts`: `export interface FrozenCardOptions { deletable?: boolean }`; `frozenCard(entry, opts?: FrozenCardOptions)`; `renderFreezerCards(freezer, entries, opts?: FrozenCardOptions)`.
  - `wc-freezer-delete.ts`: `wireFreezerDelete(deps: FreezerDeleteDeps): FreezerDeleteHandles` with

```ts
export interface FreezerDeleteDeps {
  freezer: HTMLElement;
  openVfs(): Promise<WcPageVfs>;
  getEntries(): readonly FrozenSessionIndexEntry[];
  getViewedId(): string | null;
  leaveViewed(entry: FrozenSessionIndexEntry): void;
  refreshFreezer(): void;
  log: BootStageLogger;
}
export interface FreezerDeleteHandles {
  dialog(): HTMLElement | null;
}
```

- [ ] **Step 1: Write the failing tests**

(a) In `packages/webapp/tests/ui/wc/wc-freezer.test.ts`, inside `describe('frozenCard', ...)`, add:

```ts
it('marks finished chats deletable only when asked, never a live snapshot', () => {
  expect(frozenCard(ENTRY).hasAttribute('deletable')).toBe(false);
  expect(frozenCard(ENTRY, { deletable: true }).hasAttribute('deletable')).toBe(true);
  expect(frozenCard({ ...ENTRY, live: true }, { deletable: true }).hasAttribute('deletable')).toBe(
    false
  );
});
```

(b) Create `packages/webapp/tests/ui/wc/wc-freezer-delete.test.ts`:

```ts
// @vitest-environment jsdom
/**
 * Freezer delete flow: trash → confirm dialog naming the chat → delete →
 * close + refresh; a failure keeps the dialog for a retry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const mockDelete = vi.fn();
vi.mock('../../../src/ui/frozen-session-delete.js', () => ({
  deleteFrozenSession: (...args: unknown[]) => mockDelete(...args),
}));

import type { FrozenSessionIndexEntry } from '../../../src/ui/wc/wc-freezer.js';
import { type FreezerDeleteDeps, wireFreezerDelete } from '../../../src/ui/wc/wc-freezer-delete.js';

const ENTRY: FrozenSessionIndexEntry = {
  filename: '2026-06-01T10-00-00Z-fix-build.md',
  sessionId: 'sid-1',
  title: 'Fix the build',
  frozenAt: '2026-06-01T10:00:00Z',
  messageCount: 2,
};

function card(slug: string): HTMLElement {
  const el = document.createElement('slicc-freezer-card');
  el.setAttribute('slug', slug);
  const btn = document.createElement('button');
  btn.className = 'slicc-fzcard__delete';
  el.append(btn);
  return el;
}

function harness(overrides: Partial<FreezerDeleteDeps> = {}) {
  document.body.replaceChildren();
  const freezer = document.createElement('slicc-freezer');
  freezer.append(card(ENTRY.filename));
  document.body.append(freezer);
  const writer = { tag: 'writer' };
  const deps: FreezerDeleteDeps = {
    freezer,
    openVfs: vi.fn(async () => ({ reader: {}, writer }) as never),
    getEntries: () => [ENTRY],
    getViewedId: () => null,
    leaveViewed: vi.fn(),
    refreshFreezer: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ...overrides,
  };
  const handles = wireFreezerDelete(deps);
  return { freezer, deps, handles, writer };
}

function ask(freezer: HTMLElement, slug = ENTRY.filename): void {
  freezer
    .querySelector('slicc-freezer-card')!
    .dispatchEvent(
      new CustomEvent('freezer-card-delete', { bubbles: true, composed: true, detail: { slug } })
    );
}

const action = (name: string) =>
  document.querySelector<HTMLButtonElement>(`slicc-dialog [data-cone-action="${name}"]`)!;

beforeEach(() => {
  mockDelete.mockReset();
});

describe('wireFreezerDelete', () => {
  it('opens a confirm that names the chat and says memories are kept', () => {
    const { freezer, handles } = harness();
    ask(freezer);
    const dialog = handles.dialog()!;
    expect(dialog.getAttribute('heading')).toBe('Delete frozen chat?');
    expect(dialog.textContent).toContain(
      '“Fix the build” and its transcript will be permanently deleted. Memories already learned from it are kept.'
    );
    expect(action('delete').textContent).toBe('Delete');
    expect(action('cancel').textContent).toBe('Cancel');
  });

  it('Cancel closes without deleting', () => {
    const { freezer, handles, deps } = harness();
    ask(freezer);
    action('cancel').click();
    expect(handles.dialog()).toBeNull();
    expect(document.querySelector('slicc-dialog')).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(deps.refreshFreezer).not.toHaveBeenCalled();
  });

  it('Delete deletes by filename + sessionId, closes and refreshes the rail', async () => {
    mockDelete.mockResolvedValue({ status: 'deleted' });
    const { freezer, handles, deps, writer } = harness();
    ask(freezer);
    action('delete').click();

    await vi.waitFor(() => expect(deps.refreshFreezer).toHaveBeenCalled());
    expect(mockDelete).toHaveBeenCalledWith(writer, {
      filename: ENTRY.filename,
      sessionId: 'sid-1',
    });
    expect(handles.dialog()).toBeNull();
    expect(deps.leaveViewed).not.toHaveBeenCalled();
  });

  it('deleting the chat on screen leaves it', async () => {
    mockDelete.mockResolvedValue({ status: 'deleted' });
    const { freezer, deps } = harness({ getViewedId: () => 'sid-1' });
    ask(freezer);
    action('delete').click();
    await vi.waitFor(() => expect(deps.leaveViewed).toHaveBeenCalledWith(ENTRY));
  });

  it('a failed delete keeps the dialog with an error and re-enables Delete', async () => {
    mockDelete.mockResolvedValue({ status: 'failed', errors: ['/sessions/x.md: EIO'] });
    const { freezer, handles, deps } = harness();
    ask(freezer);
    action('delete').click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-freezer-delete-error]')?.textContent).toBe(
        "Couldn't delete everything — try again."
      )
    );
    expect(handles.dialog()).not.toBeNull();
    expect(action('delete').disabled).toBe(false);
    expect(deps.refreshFreezer).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalled();
  });

  it('a thrown error is handled like a failed delete', async () => {
    const { freezer, deps } = harness({
      openVfs: vi.fn(async () => {
        throw new Error('vfs gone');
      }),
    });
    ask(freezer);
    action('delete').click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-freezer-delete-error]')).not.toBeNull()
    );
    expect(deps.refreshFreezer).not.toHaveBeenCalled();
  });

  it('ignores live rows, unknown slugs, and a second request for an open slug', () => {
    const live = harness({ getEntries: () => [{ ...ENTRY, live: true }] });
    ask(live.freezer);
    expect(live.handles.dialog()).toBeNull();

    const unknown = harness();
    ask(unknown.freezer, 'nope.md');
    expect(unknown.handles.dialog()).toBeNull();

    const twice = harness();
    ask(twice.freezer);
    ask(twice.freezer);
    expect(document.querySelectorAll('slicc-dialog')).toHaveLength(1);
  });

  it('moves focus to the re-rendered card when a refresh replaced the opener', () => {
    const { freezer } = harness();
    ask(freezer);
    const replacement = card(ENTRY.filename);
    freezer.replaceChildren(replacement);
    action('cancel').click();
    expect(document.activeElement).toBe(replacement.querySelector('.slicc-fzcard__delete'));
  });
});
```

(c) Create `packages/webapp/tests/ui/wc/wc-live-freezer-delete.test.ts`:

```ts
// @vitest-environment jsdom
/**
 * The leader rail renders finished frozen chats as deletable and, when the
 * chat on screen is deleted, clears the thread BEFORE handing back to its cone.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const mockDelete = vi.fn(async (..._args: unknown[]) => ({ status: 'deleted' as const }));
vi.mock('../../../src/ui/frozen-session-delete.js', () => ({
  deleteFrozenSession: (...args: unknown[]) => mockDelete(...args),
}));

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import { wireFreezerRail } from '../../../src/ui/wc/wc-live-freezer.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';

const research = {
  jid: 'cone_2',
  name: 'Research',
  folder: 'cone-research',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'Research',
  addedAt: '2026-01-02T00:00:00.000Z',
  parentJid: null,
} as unknown as RegisteredScoop;

const FILE = '2026-06-01T10-00-00Z-fix-build.md';
const LIVE = 'live-cone-x1.md';
const INDEX = [
  {
    filename: FILE,
    sessionId: 'sid-a',
    title: 'Fix the build',
    frozenAt: '2026-06-01T10:00:00Z',
    messageCount: 1,
    cone: 'cone-research',
  },
  {
    filename: LIVE,
    sessionId: 'sid-live',
    title: 'In progress',
    frozenAt: '2026-06-02T10:00:00Z',
    messageCount: 1,
    live: true,
  },
];
const ARCHIVE = [
  '---',
  'title: "Fix the build"',
  '---',
  '<!-- slicc:session-data',
  JSON.stringify([{ id: 'u1', role: 'user', content: 'fix the build', timestamp: 1 }]),
  '-->',
  '',
  '# Fix the build',
  '',
].join('\n');

function harness() {
  document.body.replaceChildren();
  const freezer = document.createElement('slicc-freezer');
  document.body.append(freezer);
  const files = new Map<string, string>([
    ['/sessions/index.json', JSON.stringify(INDEX)],
    [`/sessions/${FILE}`, ARCHIVE],
  ]);
  const reader = {
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return text;
    },
    readDir: async () => [],
  };
  const controller = { loadMessages: vi.fn() };
  const selectScoop = vi.fn();
  const unit = recordToWorkUnitSummary(research, {});
  const refs = {
    freezer,
    thread: document.createElement('slicc-thread'),
    inputCard: document.createElement('slicc-input-card'),
    switcher: document.createElement('slicc-switcher'),
    shader: document.createElement('slicc-shader'),
    frame: document.createElement('div'),
  };
  const handles = wireFreezerRail({
    refs: refs as unknown as Parameters<typeof wireFreezerRail>[0]['refs'],
    openVfs: async () =>
      ({ reader, writer: { writeFile: vi.fn(async () => undefined) } }) as unknown as Awaited<
        ReturnType<Parameters<typeof wireFreezerRail>[0]['openVfs']>
      >,
    client: {
      getScoops: () => [research],
      clearAllMessages: vi.fn(async () => undefined),
      spawnAgent: vi.fn(),
    } as unknown as OffscreenClient,
    getController: () => controller as never,
    getSelected: () => null,
    getUnits: () => [unit],
    selectScoop,
    clearSelection: vi.fn(),
    holdQueuedPile: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  return { freezer, handles, controller, selectScoop, unit };
}

const cardFor = (freezer: HTMLElement, slug: string) =>
  Array.from(freezer.querySelectorAll('slicc-freezer-card')).find(
    (card) => card.getAttribute('slug') === slug
  );

describe('Freezer rail → delete', () => {
  it('renders finished chats as deletable, never the live one', async () => {
    const { freezer, handles } = harness();
    handles.refreshFreezer();
    await vi.waitFor(() => expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(2));
    expect(cardFor(freezer, FILE)?.hasAttribute('deletable')).toBe(true);
    expect(cardFor(freezer, LIVE)?.hasAttribute('deletable')).toBe(false);
  });

  it('deleting the chat on screen clears the thread before handing back to its cone', async () => {
    const { freezer, handles, controller, selectScoop, unit } = harness();
    handles.refreshFreezer();
    await vi.waitFor(() => expect(cardFor(freezer, FILE)).toBeDefined());
    await handles.openFrozen(FILE);
    expect(handles.getViewedFrozenSessionId()).toBe('sid-a');

    cardFor(freezer, FILE)!.dispatchEvent(
      new CustomEvent('freezer-card-delete', {
        bubbles: true,
        composed: true,
        detail: { slug: FILE },
      })
    );
    document.querySelector<HTMLButtonElement>('slicc-dialog [data-cone-action="delete"]')!.click();

    await vi.waitFor(() => expect(selectScoop).toHaveBeenCalledWith(unit));
    expect(mockDelete).toHaveBeenCalledWith(expect.anything(), {
      filename: FILE,
      sessionId: 'sid-a',
    });
    const cleared = controller.loadMessages.mock.calls.findIndex(
      ([messages]) => Array.isArray(messages) && messages.length === 0
    );
    expect(cleared).toBeGreaterThan(-1);
    expect(controller.loadMessages.mock.invocationCallOrder[cleared]).toBeLessThan(
      selectScoop.mock.invocationCallOrder[0]!
    );
    expect(handles.getViewedFrozenSessionId()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-freezer.test.ts packages/webapp/tests/ui/wc/wc-freezer-delete.test.ts packages/webapp/tests/ui/wc/wc-live-freezer-delete.test.ts`
Expected: FAIL — `frozenCard` ignores options; `wc-freezer-delete.js` missing; cards not deletable.

- [ ] **Step 3: Implement**

`packages/webapp/src/ui/wc/wc-cone-actions.ts`: add `export` to `const BTN_DANGER`, `const BTN_PLAIN`, `type ConeDialog`, `interface ConeDialogSpec`, and `function buildConeDialog` (no other change).

`packages/webapp/src/ui/wc/wc-freezer.ts` — replace `frozenCard` and `renderFreezerCards` with:

```ts
/** Per-host card options: only the leader rail can delete. */
export interface FrozenCardOptions {
  /** Offer the card's trash button (never on a live snapshot). */
  deletable?: boolean;
}

/** Build one freezer card; `slug` carries the archive filename. */
export function frozenCard(
  entry: FrozenSessionIndexEntry,
  opts: FrozenCardOptions = {}
): HTMLElement {
  const card = document.createElement('slicc-freezer-card');
  card.setAttribute('title', entry.title);
  card.setAttribute('meta', metaLine(entry));
  card.setAttribute('slug', entry.filename);
  if (entry.icon) card.setAttribute('icon', entry.icon);
  if (opts.deletable && !entry.live) card.setAttribute('deletable', '');
  return card;
}
```

```ts
/**
 * Repopulate the freezer rail's cards. Existing cards are replaced; the
 * `<slicc-freezer-new>` launcher and other children stay.
 */
export function renderFreezerCards(
  freezer: HTMLElement,
  entries: readonly FrozenSessionIndexEntry[],
  opts: FrozenCardOptions = {}
): void {
  for (const card of Array.from(freezer.querySelectorAll('slicc-freezer-card'))) card.remove();
  freezer.append(...entries.map((entry) => frozenCard(entry, opts)));
}
```

Create `packages/webapp/src/ui/wc/wc-freezer-delete.ts`:

```ts
/**
 * Delete a frozen chat from the Freezer rail. The card's trash button fires
 * `freezer-card-delete`; a confirm dialog names the chat; Delete runs
 * `deleteFrozenSession` (files first, index row last — a failure keeps the
 * card AND the dialog for a retry). Deleting the chat on screen hands back
 * to the cone it came from.
 */

import type { BootStageLogger } from '../boot/types.js';
import { BTN_DANGER, BTN_PLAIN, buildConeDialog, type ConeDialog } from './wc-cone-actions.js';
import type { FrozenSessionIndexEntry } from './wc-freezer.js';
import type { WcPageVfs } from './wc-live.js';

export interface FreezerDeleteDeps {
  /** The rail; its cards fire `freezer-card-delete`. */
  freezer: HTMLElement;
  openVfs(): Promise<WcPageVfs>;
  /** The rows the rail last rendered. */
  getEntries(): readonly FrozenSessionIndexEntry[];
  /** `sessionId ?? filename` of the frozen chat on screen, or null. */
  getViewedId(): string | null;
  /** Leave a frozen chat that was just deleted while on screen. */
  leaveViewed(entry: FrozenSessionIndexEntry): void;
  refreshFreezer(): void;
  log: BootStageLogger;
}

export interface FreezerDeleteHandles {
  /** The open confirm dialog, if any (for tests). */
  dialog(): HTMLElement | null;
}

const FAILED_COPY = "Couldn't delete everything — try again.";

function confirmBody(doc: Document, title: string): HTMLElement {
  const body = doc.createElement('p');
  body.textContent = `“${title}” and its transcript will be permanently deleted. Memories already learned from it are kept.`;
  body.style.cssText = 'font-size:0.875rem;margin:0;';
  return body;
}

function showFailure(body: HTMLElement): void {
  let line = body.parentElement?.querySelector<HTMLElement>('[data-freezer-delete-error]');
  if (!line) {
    line = body.ownerDocument.createElement('p');
    line.setAttribute('data-freezer-delete-error', '');
    line.setAttribute('role', 'alert');
    line.style.cssText = 'font-size:0.8125rem;margin:0.5rem 0 0;color:#d23;';
    body.after(line);
  }
  line.textContent = FAILED_COPY;
}

/** Focus fell to <body> because a refresh replaced the opener: use the new card. */
function restoreFocus(freezer: HTMLElement, slug: string): void {
  const doc = freezer.ownerDocument;
  if (doc.activeElement && doc.activeElement !== doc.body) return;
  const card = Array.from(freezer.querySelectorAll('slicc-freezer-card')).find(
    (candidate) => candidate.getAttribute('slug') === slug
  );
  card?.querySelector<HTMLElement>('.slicc-fzcard__delete')?.focus();
}

function deleteKey(entry: FrozenSessionIndexEntry): { filename: string; sessionId?: string } {
  return entry.sessionId
    ? { filename: entry.filename, sessionId: entry.sessionId }
    : { filename: entry.filename };
}

/** Wire the rail's trash buttons to a confirm + delete. One dialog at a time. */
export function wireFreezerDelete(deps: FreezerDeleteDeps): FreezerDeleteHandles {
  const doc = deps.freezer.ownerDocument;
  let open: { slug: string; dialog: ConeDialog } | null = null;
  const running = new Set<string>();

  const close = (): void => {
    if (!open) return;
    const { slug, dialog } = open;
    open = null;
    dialog.hide?.();
    dialog.remove();
    restoreFocus(deps.freezer, slug);
  };

  const run = async (
    entry: FrozenSessionIndexEntry,
    dialog: ConeDialog,
    body: HTMLElement
  ): Promise<void> => {
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[slot="footer"]'));
    for (const button of buttons) button.disabled = true;
    running.add(entry.filename);
    try {
      const { writer } = await deps.openVfs();
      const { deleteFrozenSession } = await import('../frozen-session-delete.js');
      const result = await deleteFrozenSession(writer, deleteKey(entry));
      if (result.status === 'failed') throw new Error(result.errors.join('; '));
      if (result.status !== 'deleted') {
        deps.log.warn('WC frozen chat delete skipped', { filename: entry.filename, ...result });
      } else if (deps.getViewedId() === (entry.sessionId ?? entry.filename)) {
        deps.leaveViewed(entry);
      }
      if (open?.dialog === dialog) close();
      deps.refreshFreezer();
    } catch (err) {
      deps.log.error('WC frozen chat delete failed', err);
      showFailure(body);
      for (const button of buttons) button.disabled = false;
    } finally {
      running.delete(entry.filename);
    }
  };

  const ask = (slug: string): void => {
    if (open?.slug === slug || running.has(slug)) return;
    const entry = deps.getEntries().find((candidate) => candidate.filename === slug);
    if (!entry || entry.live) return;
    close();
    const body = confirmBody(doc, entry.title);
    const dialog: ConeDialog = buildConeDialog(doc, {
      heading: 'Delete frozen chat?',
      body,
      actions: [
        {
          text: 'Delete',
          style: BTN_DANGER,
          data: 'delete',
          onClick: () => void run(entry, dialog, body),
        },
        { text: 'Cancel', style: BTN_PLAIN, data: 'cancel', onClick: close },
      ],
      onDismiss: (closed) => {
        if (open?.dialog === closed) open = null;
        closed.remove();
        restoreFocus(deps.freezer, slug);
      },
    });
    open = { slug, dialog };
    doc.body.append(dialog);
    dialog.show?.();
  };

  deps.freezer.addEventListener('freezer-card-delete', (event) => {
    const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
    if (slug) ask(slug);
  });

  return { dialog: () => open?.dialog ?? null };
}
```

`packages/webapp/src/ui/wc/wc-live-freezer.ts`:

1. In the `./wc-freezer.js` import list remove `rebuildFreezerIndexFromArchives` and `SESSIONS_INDEX_PATH`, add `recoverCorruptFreezerIndex`. Add `import { wireFreezerDelete } from './wc-freezer-delete.js';`.
2. Add two module-level helpers above `wireFreezerRail`'s doc comment:

```ts
/** The rail's rows: the index, or — when it is corrupt — a locked rebuild from the archives. */
async function loadFreezerEntries(
  reader: WcPageVfs['reader'],
  writer: WcPageVfs['writer'],
  log: BootStageLogger
): Promise<FrozenSessionIndexEntry[] | null> {
  const entries = await readFreezerEntries(reader);
  if (entries !== null) return entries;
  if ((await readFreezerIndexState(reader)).kind !== 'corrupt') return null;
  log.warn('WC freezer index corrupt — rebuilding from archives');
  return recoverCorruptFreezerIndex(reader, writer);
}

/** Backfill rail icons for rows without one; one pass at a time per rail. */
function backfillFreezerIcons(
  gate: { busy: boolean },
  ctx: Pick<WcPageVfs, 'reader' | 'writer'> & { freezer: HTMLElement; log: BootStageLogger },
  entries: FrozenSessionIndexEntry[]
): void {
  if (gate.busy || !entries.some((entry) => !entry.icon && !entry.pendingEnrichment)) return;
  gate.busy = true;
  void import('../../providers/quick-llm.js')
    .then(({ pickLucideIcon }) =>
      enrichFreezerIcons({
        reader: ctx.reader,
        writer: ctx.writer,
        freezer: ctx.freezer,
        entries,
        pickIcon: (subject) => pickLucideIcon({ subject }),
      })
    )
    .catch((err) => ctx.log.warn('WC freezer icon enrichment failed', err))
    .finally(() => {
      gate.busy = false;
    });
}
```

3. In `wireFreezerRail`, replace `let iconEnriching = false;` and the whole `refreshFreezer` arrow with:

```ts
const iconGate = { busy: false };
const refreshFreezer = (): void => {
  const seq = ++refreshSeq;
  void openVfs()
    .then(async ({ reader, writer }) => {
      const entries = await loadFreezerEntries(reader, writer, log);
      if (entries === null || seq !== refreshSeq) return;
      frozenEntries = entries;
      renderFreezerCards(refs.freezer, entries, { deletable: true });
      backfillFreezerIcons(iconGate, { reader, writer, freezer: refs.freezer, log }, entries);
    })
    .catch((err) => log.error('WC freezer refresh failed', err));
};
```

4. Directly before the final `return {` of `wireFreezerRail` add:

```ts
wireFreezerDelete({
  freezer: refs.freezer,
  openVfs,
  getEntries: () => frozenEntries,
  getViewedId: () => currentFrozenSessionId,
  leaveViewed: (entry) => {
    // Clear FIRST: selecting a cone loads its snapshot asynchronously and
    // keeps the old thread up if that fails.
    getController()?.loadMessages([]);
    currentFrozenSessionId = null;
    const cone = rootForConeFolder(deps.getUnits(), entry.cone);
    if (cone) selectScoop(cone);
  },
  refreshFreezer,
  log,
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/wc && npx biome check --write packages/webapp/src/ui/wc && npx tsc --noEmit -p tsconfig.json`
Expected: all `tests/ui/wc` PASS (including erase / deeplink / cone / cone-actions suites); Biome clean (in particular no `noExcessiveLinesPerFunction` on `wireFreezerRail`); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/wc packages/webapp/tests/ui/wc
git commit -m "feat(webapp): delete frozen chats from the Freezer rail

Trash icon on finished cards → confirm dialog → deleteFrozenSession.
Deleting the chat on screen clears the thread before returning to its cone.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Docs and full verification

**Files:**

- Modify: `README.md` (Cone bullet, line ~217)
- Modify: `docs/work-unit.md` ("Per-cone sessions" bullets, ~line 602)
- Modify: `docs/webcomponents-details.md` (new section before `## Slotted containment + chat-prose wrapping`)
- Modify: `packages/webapp/CLAUDE.md` ("Frozen-session recovery" never-rule)

- [ ] **Step 1: Update the docs**

`README.md` — in the Cone bullet, after the sentence `There is one Freezer for all cones; a thawed chat says which cone it came from.` insert:

```text
 Hover a frozen chat in the expanded rail and click its trash icon to delete it for good (you confirm first); memories already learned from it are kept.
```

`docs/work-unit.md` — after the bullet starting `- Thawing stays read-only`, add:

```markdown
- **Deleting a frozen chat** (`ui/frozen-session-delete.ts`; rail flow `ui/wc/wc-freezer-delete.ts`): one `serializeIndexWrite` transaction removes every file the session owns — archive, JSONL sidecar, `/sessions/attachments/<key>/`, `/sessions/data/<sessionId>/` (+ `.tmp-`), live-curation deltas, curator receipts and per-pass state — then invalidates the search index and drops the index row LAST, so a failure leaves a retryable card instead of orphans a rebuild would resurrect. Live rows are refused; memories are kept. Every other index writer updates only rows still present under the same lock (only a freeze creates rows); enrichment's `replaceIndexEntry` tells a delete (`deleted`) or a rival enrichment (`superseded`) from a lost index (`prepended`); the post-freeze curator and `onSessionSettled` skip a session the index reports `absent`. Archives carry `sessionId:` frontmatter (#3807); a `sessionId` two rows share is never used to derive a path.
```

`docs/webcomponents-details.md` — insert before `## Slotted containment + chat-prose wrapping`:

```markdown
## Freezer card delete affordance (`<slicc-freezer-card deletable>`)

`deletable` (reflected boolean) adds a trailing `trash-2` `<button part="delete">` whose `aria-label` is `Delete “<title>”` (kept in sync with `title`). It is `display: none` in the collapsed rail — out of layout and tab order — and fades in on row `:hover` / `:focus-within` when `expanded`. A click stops propagation (the row never thaws) and fires `freezer-card-delete` (composed, bubbling, `detail.slug`). The host owns confirmation and deletion; the webapp sets `deletable` only on non-live rows of the leader rail.
```

`packages/webapp/CLAUDE.md` — at the end of the `**Frozen-session recovery**` bullet (after `root cone via \`wc-unit-context.ts\`).`) append:

```text
 `/sessions/index.json` writers go through `serializeIndexWrite` and update only rows still present (only a freeze creates rows); deleting a frozen chat removes its files first and the row LAST (`ui/frozen-session-delete.ts`).
```

- [ ] **Step 2: Full verification** (fix anything red, then re-run the failing step)

```bash
npm run lint
git status --short                       # lint --write may have reformatted; review and keep
node packages/dev-tools/tools/check-touched-exemptions.mjs
npm run typecheck
npm run test
npm run test -w @slicc/webcomponents
npm run test:coverage:webapp
npm run test:coverage:webcomponents
npm run build -w @slicc/webapp
npm run build -w @slicc/chrome-extension
npm run size -w @slicc/webapp
```

Expected: every command exits 0. Coverage floors in `coverage-thresholds.json` must not be lowered.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/work-unit.md docs/webcomponents-details.md packages/webapp/CLAUDE.md
git commit -m "docs: deleting frozen chats from the Freezer

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 4: Smoke-test in a real browser** — follow `.agents/skills/cdp-smoke-test/SKILL.md` (Tier 1 boot + Freezer pane; Tier 2 if a provider is connected): freeze a chat (New chat), expand the Freezer, hover the card, click the trash icon, confirm, and verify the card disappears and `/sessions/index.json` no longer lists it (terminal: `cat /sessions/index.json`; `ls /sessions`).
