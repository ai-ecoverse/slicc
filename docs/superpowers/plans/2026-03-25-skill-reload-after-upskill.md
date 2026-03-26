# Skill Reload After Upskill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `upskill` installs new skills, all active agent contexts (cone + scoops) hot-reload their skill lists and update their system prompts — in both CLI and extension mode.

**Architecture:** Three changes — (1) `ScoopContext` gets a `reloadSkills()` method that re-reads `/workspace/skills/` and calls `agent.setSystemPrompt()`, (2) the `upskill` command triggers a reload hook after successful installs, and (3) scoops load skills from the cone's `/workspace/skills/` via an unrestricted FS reference so they see the same skills as the cone.

**Tech Stack:** TypeScript, Vitest, pi-agent-core (`Agent.setSystemPrompt`), chrome.runtime messaging (extension)

---

## File Map

| File                                                                        | Action          | Responsibility                                                                          |
| --------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `packages/webapp/src/scoops/scoop-context.ts`                               | Modify          | Add `reloadSkills()`, accept `skillsFs` param, always load from `/workspace/skills/`    |
| `packages/webapp/src/scoops/orchestrator.ts`                                | Modify          | Add `reloadAllSkills()`, pass `sharedFs` to ScoopContext, expose `__slicc_reloadSkills` |
| `packages/webapp/src/shell/supplemental-commands/upskill-command.ts`        | Modify          | Call `reloadSkillsAfterInstall()` after successful installs                             |
| `packages/chrome-extension/src/messages.ts`                                 | Modify          | Add `ReloadSkillsMsg` to `PanelToOffscreenMessage`                                      |
| `packages/chrome-extension/src/offscreen-bridge.ts`                         | Modify          | Handle `reload-skills` → `orchestrator.reloadAllSkills()`                               |
| `packages/webapp/tests/scoops/scoop-context.test.ts`                        | Modify (exists) | Add `reloadSkills()` tests                                                              |
| `packages/webapp/tests/scoops/skills.test.ts`                               | Modify (exists) | Add test for scoop loading cone skills via skillsFs                                     |
| `packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts` | Modify (exists) | Add test for reload hook being called after install                                     |

---

## Task 1: Add `reloadSkills()` to ScoopContext

**Files:**

- Modify: `packages/webapp/src/scoops/scoop-context.ts`
- Test: `packages/webapp/tests/scoops/scoop-context.test.ts`

### Design

`ScoopContext` needs to:

1. Accept an optional `skillsFs: VirtualFS` in its constructor (the unrestricted shared FS)
2. Store the skills directory and FS references for later reuse
3. Expose a `reloadSkills()` method that re-reads skills, rebuilds the system prompt, and calls `agent.setSystemPrompt()`

All contexts (cone and scoops) will load skills from `/workspace/skills/` using the unrestricted `skillsFs`. This means scoops see the same skills as the cone, including anything installed via `upskill`.

- [ ] **Step 1: Write the failing test for `reloadSkills()`**

Add to `packages/webapp/tests/scoops/scoop-context.test.ts`:

```typescript
describe('ScoopContext.reloadSkills', () => {
  it('updates system prompt when new skills are installed', async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);

    // Inject mock agent with setSystemPrompt spy
    const setSystemPrompt = vi.fn();
    const agent = {
      prompt: vi.fn(),
      abort: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      followUp: vi.fn(),
      clearAllQueues: vi.fn(),
      setSystemPrompt,
      state: { isStreaming: false, systemPrompt: 'old prompt' },
    };
    (ctx as any).agent = agent;
    (ctx as any).status = 'ready';

    // Create a real VFS with a skill
    const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
    const vfs = await VirtualFS.create({ dbName: 'test-reload-skills', wipe: true });
    await vfs.mkdir('/workspace/skills/test-skill', { recursive: true });
    await vfs.writeFile(
      '/workspace/skills/test-skill/SKILL.md',
      '---\nname: test-skill\ndescription: A test skill\n---\nTest instructions.'
    );

    // Set the skillsFs so reloadSkills can find the skill
    (ctx as any).skillsFs = vfs;

    await ctx.reloadSkills();

    expect(setSystemPrompt).toHaveBeenCalledOnce();
    const newPrompt = setSystemPrompt.mock.calls[0][0];
    expect(newPrompt).toContain('test-skill');
    expect(newPrompt).toContain('A test skill');
  });

  it('is a no-op when agent is not initialized', async () => {
    const callbacks = createMockCallbacks();
    const ctx = new ScoopContext(testScoop, callbacks, {} as any);
    // agent is null — should not throw
    await expect(ctx.reloadSkills()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `reloadSkills` is not a function

- [ ] **Step 3: Implement `reloadSkills()` and constructor changes**

In `packages/webapp/src/scoops/scoop-context.ts`:

**Constructor — add `skillsFs` parameter and store references for reload:**

```typescript
// Add new private fields:
private skillsFs: VirtualFS | null = null;
private skillsDir: string = '/workspace/skills';

// Update constructor signature (add 5th param):
constructor(
  scoop: RegisteredScoop,
  callbacks: ScoopContextCallbacks,
  fs: VirtualFS | RestrictedFS,
  sessionStore?: SessionStore,
  skillsFs?: VirtualFS
) {
  // ... existing assignments ...
  this.skillsFs = skillsFs ?? null;
}
```

**In `init()` — always use `/workspace/skills/` and prefer `skillsFs`:**

Replace the existing skills loading block (lines ~134-141):

```typescript
// Always load skills from the cone's directory.
// Use the unrestricted skillsFs when available (required for scoops
// whose RestrictedFS cannot reach /workspace/skills/).
this.skillsDir = '/workspace/skills';
const effectiveSkillsFs = (this.skillsFs ?? this.fs) as VirtualFS;

// Seed bundled defaults for scripts (and skills as fallback)
const seedDir = this.scoop.isCone
  ? '/workspace/skills'
  : `/scoops/${this.scoop.folder}/workspace/skills`;
await createDefaultSkills(this.fs as VirtualFS, seedDir);

const skills = await loadSkills(effectiveSkillsFs, this.skillsDir);
```

**Add `reloadSkills()` method:**

```typescript
/** Hot-reload skills from VFS and update the agent's system prompt. */
async reloadSkills(): Promise<void> {
  if (!this.agent) return;

  const effectiveSkillsFs = (this.skillsFs ?? this.fs) as VirtualFS;
  const skills = await loadSkills(effectiveSkillsFs, this.skillsDir);

  // Re-read memories for prompt rebuild
  let scoopMemory = '';
  const memoryPath = this.scoop.isCone
    ? '/workspace/CLAUDE.md'
    : `/scoops/${this.scoop.folder}/CLAUDE.md`;
  try {
    const content = await this.fs!.readFile(memoryPath, { encoding: 'utf-8' });
    scoopMemory = typeof content === 'string' ? content : new TextDecoder().decode(content);
  } catch { /* no memory file — expected for fresh scoops */ }

  const globalMemory = await this.callbacks.getGlobalMemory();

  const newPrompt = this.buildSystemPrompt(globalMemory, scoopMemory, skills);
  this.agent.setSystemPrompt(newPrompt);

  log.info('Skills reloaded', {
    folder: this.scoop.folder,
    skillCount: skills.length,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/scoops/scoop-context.ts packages/webapp/tests/scoops/scoop-context.test.ts
git commit -m "feat: add ScoopContext.reloadSkills() for hot-swapping skills after upskill"
```

---

## Task 2: Add `reloadAllSkills()` to Orchestrator and pass `sharedFs`

**Files:**

- Modify: `packages/webapp/src/scoops/orchestrator.ts`

- [ ] **Step 1: Pass `sharedFs` to ScoopContext constructor**

In `createScoopTab()` (around line 580 where ScoopContext is constructed), add `this.sharedFs` as the 5th argument:

Find the ScoopContext constructor call and add `this.sharedFs`:

```typescript
const context = new ScoopContext(
  scoop,
  contextCallbacks,
  fs,
  this.agentSessionStore,
  this.sharedFs
);
```

Note: locate the existing constructor call pattern — it likely uses positional args. The `SessionStore` is the 4th arg; `sharedFs` becomes the 5th.

- [ ] **Step 2: Add `reloadAllSkills()` method**

Add to the `Orchestrator` class:

```typescript
/** Reload skills on all active scoop contexts (cone + scoops). */
async reloadAllSkills(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [jid, context] of this.contexts) {
    const tab = this.tabs.get(jid);
    if (tab?.status === 'ready' || tab?.status === 'processing') {
      promises.push(
        context.reloadSkills().catch((err) => {
          log.warn('Failed to reload skills for scoop', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
        })
      );
    }
  }
  await Promise.all(promises);
  log.info('Skills reloaded across all contexts', { count: promises.length });
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 4: Run tests**

Run: `npm run test`
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/orchestrator.ts
git commit -m "feat: add Orchestrator.reloadAllSkills() and pass sharedFs to ScoopContext"
```

---

## Task 3: Wire the reload hook in CLI mode

**Files:**

- Modify: `packages/webapp/src/ui/main.ts` (standalone init section)
- Modify: `packages/webapp/src/shell/supplemental-commands/upskill-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts`

### Design

In CLI mode, the orchestrator and the terminal shell share the same `window`. We register a `window.__slicc_reloadSkills` hook on the orchestrator, and the `upskill` command calls it after successful installs.

- [ ] **Step 1: Register the hook in standalone `main.ts`**

In the standalone init section of `packages/webapp/src/ui/main.ts` (near where `__slicc_sprinkleManager` and `__slicc_orchestrator` are set, around line 1193-1194), add:

```typescript
(window as unknown as Record<string, unknown>).__slicc_reloadSkills = () =>
  orchestrator.reloadAllSkills();
```

- [ ] **Step 2: Add `reloadSkillsAfterInstall()` to upskill-command.ts**

Add a new function next to the existing `refreshSprinklesAfterInstall()` (around line 1153):

```typescript
/** After a successful install, reload skills on all active agent contexts. */
async function reloadSkillsAfterInstall(): Promise<void> {
  try {
    // CLI mode: direct window hook
    if (typeof window !== 'undefined') {
      const hook = (window as unknown as Record<string, unknown>).__slicc_reloadSkills;
      if (typeof hook === 'function') {
        await (hook as () => Promise<void>)();
        return;
      }
    }
    // Extension mode: send message to offscreen document
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'reload-skills' },
      });
    }
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 3: Call `reloadSkillsAfterInstall()` after each successful install**

Find every place `refreshSprinklesAfterInstall()` is called in `upskill-command.ts` and add `reloadSkillsAfterInstall()` right after. There are 5 call sites:

1. `installFromClawHub` (around line 710): after `await refreshSprinklesAfterInstall();`
2. `installFromGitHub` ZIP path (around line 1033): after `await refreshSprinklesAfterInstall();`
3. `installFromGitHub` API path (around line 1099): after `await refreshSprinklesAfterInstall();`
4. Batch install at end of GitHub flow (around line 1525): after `await refreshSprinklesAfterInstall();`
5. `skill install` subcommand (around line 1646): after `await refreshSprinklesAfterInstall();` — this is in `createSkillCommand()`, not `createUpskillCommand()`, but lives in the same file

At each site, add:

```typescript
await reloadSkillsAfterInstall();
```

- [ ] **Step 4: Add test for reload hook**

Add to `packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts`. Find an existing GitHub install test and verify the reload hook is called. The test setup already mocks `window` and `fetch`. Add a spy on `window.__slicc_reloadSkills`:

```typescript
it('calls reloadSkillsAfterInstall after successful GitHub install', async () => {
  const reloadSpy = vi.fn().mockResolvedValue(undefined);
  (globalThis as any).window = {
    ...(globalThis as any).window,
    __slicc_reloadSkills: reloadSpy,
  };

  // ... run the install command (reuse an existing test's setup) ...

  expect(reloadSpy).toHaveBeenCalled();
});
```

Note: Adapt this to match the existing test patterns in the file. The test may need to set up the `window` mock before the command runs and clean it up after.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add packages/webapp/src/ui/main.ts packages/webapp/src/shell/supplemental-commands/upskill-command.ts packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts
git commit -m "feat: wire skill reload hook in CLI mode after upskill install"
```

---

## Task 4: Wire the reload in extension mode

**Files:**

- Modify: `packages/chrome-extension/src/messages.ts`
- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`
- Modify: `packages/webapp/src/ui/main.ts` (extension init section)

### Design

In extension mode, `upskill` runs in the side panel shell. The agent/orchestrator lives in the offscreen document. We need a `chrome.runtime` message relay.

The `reloadSkillsAfterInstall()` function from Task 3 already handles extension mode by sending `{ source: 'panel', payload: { type: 'reload-skills' } }`. We just need the receiving side.

- [ ] **Step 1: Add `ReloadSkillsMsg` type**

In `packages/chrome-extension/src/messages.ts`, add the message interface and include it in the union:

```typescript
// Add after SprinkleLickMsg interface:
/** Request skill reload after upskill install. */
export interface ReloadSkillsMsg {
  type: 'reload-skills';
}
```

Add `ReloadSkillsMsg` to the `PanelToOffscreenMessage` union:

```typescript
export type PanelToOffscreenMessage =
  | UserMessageMsg
  | ScoopCreateMsg
  // ... existing members ...
  | SprinkleLickMsg
  | ReloadSkillsMsg;
```

- [ ] **Step 2: Handle in offscreen bridge**

In `packages/chrome-extension/src/offscreen-bridge.ts`, add a case to the switch statement in the message handler (after the `sprinkle-lick` case, before `panel-cdp-command`):

```typescript
case 'reload-skills': {
  this.orchestrator.reloadAllSkills().catch((err) => {
    console.warn('[offscreen-bridge] Skill reload failed:', err);
  });
  break;
}
```

- [ ] **Step 3: Register the hook in extension `mainExtension()` too**

In `packages/webapp/src/ui/main.ts`, inside the `mainExtension()` function (near where `__slicc_sprinkleManager` is set, around line 463), add:

```typescript
(window as unknown as Record<string, unknown>).__slicc_reloadSkills = () => {
  chrome.runtime.sendMessage({
    source: 'panel',
    payload: { type: 'reload-skills' },
  });
  return Promise.resolve();
};
```

This ensures the same `window.__slicc_reloadSkills` hook works in extension mode too — it sends the message to offscreen. The `upskill` command just calls the hook without caring which mode it's in.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: All passing

- [ ] **Step 6: Build extension**

Run: `npm run build:extension`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
git add packages/chrome-extension/src/messages.ts packages/chrome-extension/src/offscreen-bridge.ts packages/webapp/src/ui/main.ts
git commit -m "feat: wire skill reload for extension mode via chrome.runtime messaging"
```

---

## Task 5: Test scoop skill visibility end-to-end

**Files:**

- Modify: `packages/webapp/tests/scoops/skills.test.ts`

### Design

Verify that when `loadSkills` is called with an unrestricted FS pointing to `/workspace/skills/`, it finds skills installed there — even though the scoop's own RestrictedFS can't reach that path. This validates the Task 1 `skillsFs` approach.

- [ ] **Step 1: Write the test**

Add to `packages/webapp/tests/scoops/skills.test.ts`:

```typescript
describe('scoop skill visibility via skillsFs', () => {
  it('loads cone-installed skills when given unrestricted FS', async () => {
    const sharedFs = await VirtualFS.create({
      dbName: `test-scoop-visibility-${dbCounter++}`,
      wipe: true,
    });

    // Simulate upskill installing a skill to cone's directory
    await sharedFs.mkdir('/workspace/skills/migrations', { recursive: true });
    await sharedFs.writeFile(
      '/workspace/skills/migrations/SKILL.md',
      '---\nname: migrations\ndescription: Migrate pages\n---\nMigration instructions.'
    );

    // Load skills from /workspace/skills/ using the unrestricted FS
    // (this is what scoops will do after the fix)
    const skills = await loadSkills(sharedFs, '/workspace/skills');

    expect(skills.some((s) => s.metadata.name === 'migrations')).toBe(true);
  });

  it('RestrictedFS cannot reach /workspace/skills/', async () => {
    const { RestrictedFS } = await import('../../src/fs/restricted-fs.js');
    const sharedFs = await VirtualFS.create({
      dbName: `test-scoop-restricted-${dbCounter++}`,
      wipe: true,
    });

    await sharedFs.mkdir('/workspace/skills/test-skill', { recursive: true });
    await sharedFs.writeFile(
      '/workspace/skills/test-skill/SKILL.md',
      '---\nname: test-skill\ndescription: Test\n---\nTest.'
    );

    // Scoop's RestrictedFS blocks /workspace/
    const restrictedFs = new RestrictedFS(sharedFs, ['/scoops/my-scoop/', '/shared/']);
    const skills = await loadSkills(restrictedFs as any, '/workspace/skills');

    // Should find nothing — confirming the problem this fix addresses
    expect(skills).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run packages/webapp/tests/scoops/skills.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS — both tests confirm the behavior

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/tests/scoops/skills.test.ts
git commit -m "test: verify scoop skill visibility via unrestricted skillsFs"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 2: Run full test suite**

Run: `npm run test`
Expected: All 2242+ tests passing

- [ ] **Step 3: Build both targets**

Run: `npm run build && npm run build:extension`
Expected: Clean builds

- [ ] **Step 4: Manual smoke test (CLI)**

1. Start fresh: `npm run dev:full`
2. In sliccy's terminal: `upskill aemcoder/skills --all` (or any repo with skills)
3. In sliccy's chat: ask about the newly installed skill
4. Verify: the agent's system prompt should list the new skill without restarting

- [ ] **Step 5: Manual smoke test (Extension)**

1. Build extension: `npm run build:extension`
2. Load `dist/extension/` as unpacked extension in Chrome
3. In terminal tab: run `upskill` to install a skill
4. In chat: verify the agent knows about the newly installed skill

- [ ] **Step 6: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address review feedback from verification"
```
