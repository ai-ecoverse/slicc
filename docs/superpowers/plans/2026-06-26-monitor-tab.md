# Monitor Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in "monitor" tab to the SLICC workbench that shows a read-only dashboard of all managed resources (scoops, cron tasks, webhooks, workflows, mounts, MCP servers, OAuth accounts).

**Architecture:** New `wc-monitor.ts` module renders sectioned lists from multiple data sources (IDB, VFS, in-memory client state). Integrates as a built-in surface alongside files/terminal/memory — same lazy-activation pattern. Collapsible sections with status dots and count badges.

**Tech Stack:** Vanilla TypeScript DOM construction (no framework — same pattern as `wc-memory.ts`), IndexedDB reads via `scoops/db.ts`, VFS reads via `LocalVfsClient`, `OffscreenClient.getScoops()` for scoop state.

## Global Constraints

- Node >= 22
- No framework — vanilla TS DOM, `document.createElement`
- Follow existing `wc-` module naming in `packages/webapp/src/ui/wc/`
- Tests use vitest + jsdom + `fake-indexeddb/auto` + `installWcDomStubs()`
- Keep coverage at or above package floor
- CSS inlined in `wc-shell.ts`'s `CSS` constant (same as `.wcui-memory`, `.wcui-term`)

---

### Task 1: Create `wc-monitor.ts` — data fetching and DOM rendering

**Files:**

- Create: `packages/webapp/src/ui/wc/wc-monitor.ts`
- Test: `packages/webapp/tests/ui/wc/wc-monitor.test.ts`

**Interfaces:**

- Consumes: `LocalVfsClient` (from `packages/webapp/src/kernel/local-vfs-client.ts`), `OffscreenClient` (from `packages/webapp/src/ui/offscreen-client.ts`), `getAllMountEntries` (from `packages/webapp/src/fs/mount-table-store.ts`), `getAllWebhooks`/`getAllCronTasks` (from `packages/webapp/src/scoops/db.ts`)
- Produces: `buildMonitorSections(deps: MonitorDeps): Promise<HTMLElement>` — returns a root `<div>` with all sections rendered. Later tasks call this from the workbench activator.

- [ ] **Step 1: Write failing tests for section rendering**

```typescript
// packages/webapp/tests/ui/wc/wc-monitor.test.ts
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { buildMonitorSections, type MonitorDeps } from '../../../src/ui/wc/wc-monitor.js';

function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    getScoops: () => [],
    isProcessing: () => false,
    getCronTasks: async () => [],
    getWebhooks: async () => [],
    getMounts: async () => [],
    getMcpServers: async () => ({}),
    getOAuthProviders: () => [],
    ...overrides,
  };
}

describe('buildMonitorSections', () => {
  it('renders all seven section headers', async () => {
    const root = await buildMonitorSections(makeDeps());
    const headers = root.querySelectorAll('.monitor-section__header');
    expect(headers).toHaveLength(7);
  });

  it('shows scoop rows with status', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getScoops: () => [
          { jid: 'cone-1', name: 'sliccy', isCone: true } as any,
          { jid: 's-1', name: 'researcher', isCone: false } as any,
        ],
        isProcessing: (jid) => jid === 'cone-1',
      })
    );
    const scoopRows = root.querySelectorAll('[data-section="scoops"] .monitor-row');
    expect(scoopRows).toHaveLength(2);
    expect(scoopRows[0].querySelector('.monitor-row__name')!.textContent).toBe('sliccy (cone)');
    expect(scoopRows[0].querySelector('.monitor-row__dot--active')).not.toBeNull();
  });

  it('shows cron task rows with schedule', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getCronTasks: async () => [
          {
            id: 'c1',
            name: 'daily-check',
            cron: '0 9 * * *',
            scoop: 'researcher',
            status: 'active',
            nextRun: null,
            lastRun: null,
            createdAt: '',
          },
        ],
      })
    );
    const cronRows = root.querySelectorAll('[data-section="cron"] .monitor-row');
    expect(cronRows).toHaveLength(1);
    expect(cronRows[0].querySelector('.monitor-row__name')!.textContent).toBe('daily-check');
    expect(cronRows[0].querySelector('.monitor-row__meta')!.textContent).toContain('0 9 * * *');
  });

  it('shows empty sections with count 0', async () => {
    const root = await buildMonitorSections(makeDeps());
    const counts = root.querySelectorAll('.monitor-section__count');
    for (const count of counts) {
      expect(count.textContent).toBe('0');
    }
  });

  it('shows webhook rows', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getWebhooks: async () => [{ id: 'w1', name: 'gh-push', createdAt: '', scoop: 'cone' }],
      })
    );
    const rows = root.querySelectorAll('[data-section="webhooks"] .monitor-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('gh-push');
  });

  it('shows mount rows with kind', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getMounts: async () => [
          {
            targetPath: '/workspace/proj',
            descriptor: { kind: 'local', mountId: 'm1', idbHandleKey: 'k' },
            createdAt: 0,
          },
        ],
      })
    );
    const rows = root.querySelectorAll('[data-section="mounts"] .monitor-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('/workspace/proj');
    expect(rows[0].querySelector('.monitor-row__meta')!.textContent).toBe('local');
  });

  it('shows MCP server rows with tool count', async () => {
    const root = await buildMonitorSections(
      makeDeps({
        getMcpServers: async () => ({
          github: { url: 'https://github.mcp', tools: [{}, {}, {}] } as any,
        }),
      })
    );
    const rows = root.querySelectorAll('[data-section="mcp"] .monitor-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.monitor-row__name')!.textContent).toBe('github');
    expect(rows[0].querySelector('.monitor-row__meta')!.textContent).toBe('3 tools');
  });

  it('persists collapse state', async () => {
    localStorage.setItem('slicc_monitor_collapsed', JSON.stringify(['webhooks']));
    const root = await buildMonitorSections(makeDeps());
    const webhookSection = root.querySelector('[data-section="webhooks"]')!;
    expect(
      webhookSection.querySelector('.monitor-section__body')!.getAttribute('hidden')
    ).not.toBeNull();
    localStorage.removeItem('slicc_monitor_collapsed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-monitor.test.ts`
Expected: FAIL — module `wc-monitor.js` does not exist

- [ ] **Step 3: Implement `wc-monitor.ts`**

```typescript
// packages/webapp/src/ui/wc/wc-monitor.ts
/**
 * Monitor surface for the WC workbench: read-only dashboard of all resources
 * managed by SLICC — scoops, cron tasks, webhooks, mounts, MCP servers,
 * and OAuth accounts.
 */

import type { CronTaskEntry, WebhookEntry } from '../../scoops/lick-manager.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { MountTableEntry } from '../../fs/mount-table-store.js';

export interface MonitorDeps {
  getScoops(): RegisteredScoop[];
  isProcessing(jid: string): boolean;
  getCronTasks(): Promise<CronTaskEntry[]>;
  getWebhooks(): Promise<WebhookEntry[]>;
  getMounts(): Promise<MountTableEntry[]>;
  getMcpServers(): Promise<Record<string, { url: string; tools?: unknown[] }>>;
  getOAuthProviders(): string[];
}

interface SectionDef {
  id: string;
  label: string;
  render(container: HTMLElement): Promise<void> | void;
}

const COLLAPSE_KEY = 'slicc_monitor_collapsed';

function getCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function setCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* localStorage unavailable */
  }
}

function createRow(name: string, meta: string, active?: boolean, error?: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'monitor-row';
  const dot = document.createElement('span');
  dot.className = `monitor-row__dot${active ? ' monitor-row__dot--active' : ''}${error ? ' monitor-row__dot--error' : ''}`;
  const nameEl = document.createElement('span');
  nameEl.className = 'monitor-row__name';
  nameEl.textContent = name;
  const metaEl = document.createElement('span');
  metaEl.className = 'monitor-row__meta';
  metaEl.textContent = meta;
  row.append(dot, nameEl, metaEl);
  return row;
}

function createSection(
  id: string,
  label: string,
  count: number,
  collapsed: Set<string>,
  onToggle: (id: string, expanded: boolean) => void
): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement('div');
  section.className = 'monitor-section';
  section.dataset.section = id;
  if (count === 0) section.classList.add('monitor-section--empty');

  const header = document.createElement('button');
  header.className = 'monitor-section__header';
  const isCollapsed = collapsed.has(id);
  header.setAttribute('aria-expanded', String(!isCollapsed));

  const toggle = document.createElement('span');
  toggle.className = 'monitor-section__toggle';
  toggle.textContent = isCollapsed ? '▸' : '▾';

  const title = document.createElement('span');
  title.className = 'monitor-section__title';
  title.textContent = label;

  const badge = document.createElement('span');
  badge.className = 'monitor-section__count';
  badge.textContent = String(count);

  header.append(toggle, title, badge);

  const body = document.createElement('div');
  body.className = 'monitor-section__body';
  if (isCollapsed) body.setAttribute('hidden', '');

  header.addEventListener('click', () => {
    const nowExpanded = body.hasAttribute('hidden');
    if (nowExpanded) {
      body.removeAttribute('hidden');
      toggle.textContent = '▾';
      header.setAttribute('aria-expanded', 'true');
      collapsed.delete(id);
    } else {
      body.setAttribute('hidden', '');
      toggle.textContent = '▸';
      header.setAttribute('aria-expanded', 'false');
      collapsed.add(id);
    }
    onToggle(id, nowExpanded);
    setCollapsed(collapsed);
  });

  section.append(header, body);
  return { section, body };
}

export async function buildMonitorSections(deps: MonitorDeps): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.className = 'wcui-monitor';
  const collapsed = getCollapsed();
  const onToggle = (): void => {};

  const scoops = deps.getScoops();
  const [cronTasks, webhooks, mounts, mcpServers] = await Promise.all([
    deps.getCronTasks().catch(() => [] as CronTaskEntry[]),
    deps.getWebhooks().catch(() => [] as WebhookEntry[]),
    deps.getMounts().catch(() => [] as MountTableEntry[]),
    deps.getMcpServers().catch(() => ({}) as Record<string, { url: string; tools?: unknown[] }>),
  ]);
  const oauthProviders = deps.getOAuthProviders();
  const mcpEntries = Object.entries(mcpServers);

  const sections: SectionDef[] = [
    {
      id: 'scoops',
      label: 'Scoops',
      render(body) {
        for (const scoop of scoops) {
          const label = scoop.isCone ? `${scoop.name || 'sliccy'} (cone)` : scoop.name;
          const processing = deps.isProcessing(scoop.jid);
          body.append(createRow(label, processing ? 'processing' : 'idle', processing));
        }
      },
    },
    {
      id: 'cron',
      label: 'Cron Tasks',
      render(body) {
        for (const task of cronTasks) {
          body.append(createRow(task.name, task.cron, task.status === 'active'));
        }
      },
    },
    {
      id: 'webhooks',
      label: 'Webhooks',
      render(body) {
        for (const wh of webhooks) {
          body.append(createRow(wh.name, wh.scoop ? `→ ${wh.scoop}` : '→ cone'));
        }
      },
    },
    {
      id: 'workflows',
      label: 'Workflows',
      render(body) {
        // Workflows run in the kernel worker — reading their state requires
        // a panel-RPC round-trip. For v1, this section is populated but empty
        // unless the caller injects workflow data in a future iteration.
      },
    },
    {
      id: 'mounts',
      label: 'Mounts',
      render(body) {
        for (const mount of mounts) {
          body.append(createRow(mount.targetPath, mount.descriptor.kind));
        }
      },
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      render(body) {
        for (const [name, entry] of mcpEntries) {
          const toolCount = entry.tools?.length ?? 0;
          body.append(createRow(name, `${toolCount} tool${toolCount !== 1 ? 's' : ''}`));
        }
      },
    },
    {
      id: 'oauth',
      label: 'OAuth',
      render(body) {
        for (const provider of oauthProviders) {
          body.append(createRow(provider, ''));
        }
      },
    },
  ];

  for (const def of sections) {
    let count = 0;
    if (def.id === 'scoops') count = scoops.length;
    else if (def.id === 'cron') count = cronTasks.length;
    else if (def.id === 'webhooks') count = webhooks.length;
    else if (def.id === 'workflows') count = 0;
    else if (def.id === 'mounts') count = mounts.length;
    else if (def.id === 'mcp') count = mcpEntries.length;
    else if (def.id === 'oauth') count = oauthProviders.length;

    const { section, body } = createSection(def.id, def.label, count, collapsed, onToggle);
    def.render(body);
    root.append(section);
  }

  return root;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-monitor.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/wc/wc-monitor.ts packages/webapp/tests/ui/wc/wc-monitor.test.ts
git commit -m "feat(webapp): add wc-monitor module with sectioned dashboard rendering"
```

---

### Task 2: Wire monitor tab into the workbench (BASE_TABS, surface, CSS, activation)

**Files:**

- Modify: `packages/webapp/src/ui/wc/wc-sprinkles.ts:103-107` (add monitor to BASE_TABS)
- Modify: `packages/webapp/src/ui/wc/wc-shell.ts:216-258` (add monitor surface + CSS)
- Modify: `packages/webapp/src/ui/wc/wc-shell.ts:66` (add `monitorHost` to `WcShellRefs`)
- Modify: `packages/webapp/src/ui/wc/wc-workbench.ts:69-116` (add monitor activation handler + deps)
- Modify: `packages/webapp/src/ui/wc/wc-live.ts:1350-1359` (wire `monitorHost` into activator deps)

**Interfaces:**

- Consumes: `buildMonitorSections` from Task 1, `WcShellRefs`, `WcWorkbenchDeps`, `createWorkbenchActivator`
- Produces: A working "monitor" dock item that renders the monitor sections on activation

- [ ] **Step 1: Add monitor to `BASE_TABS` in `wc-sprinkles.ts`**

In `packages/webapp/src/ui/wc/wc-sprinkles.ts`, change line 103-107:

```typescript
const BASE_TABS: readonly TabDescriptor[] = [
  { id: 'files', label: 'files', kind: 'tool' },
  { id: 'term', label: 'terminal', kind: 'tool' },
  { id: 'memory', label: 'memory', kind: 'tool' },
  { id: 'monitor', label: 'monitor', kind: 'tool' },
];
```

- [ ] **Step 2: Add monitor CSS to `wc-shell.ts`**

In `packages/webapp/src/ui/wc/wc-shell.ts`, add to the `CSS` array (after the `.wcui-memory` rule):

```typescript
'.wcui-monitor{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;',
'gap:2px;padding:10px;font-size:12px;color:var(--txt);}',
'.monitor-section{border-bottom:1px solid var(--border,rgba(255,255,255,.06));}',
'.monitor-section--empty{opacity:.5;}',
'.monitor-section__header{display:flex;align-items:center;gap:6px;width:100%;',
'padding:8px 0;background:none;border:none;color:var(--txt-2);cursor:pointer;',
'font:inherit;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;}',
'.monitor-section__header:hover{color:var(--txt);}',
'.monitor-section__toggle{width:10px;text-align:center;font-size:10px;}',
'.monitor-section__title{flex:1;text-align:left;}',
'.monitor-section__count{background:var(--bg-3,rgba(255,255,255,.08));border-radius:8px;',
'padding:0 6px;font-size:10px;line-height:18px;min-width:18px;text-align:center;}',
'.monitor-section__body{padding:0 0 6px 4px;}',
'.monitor-section__body[hidden]{display:none;}',
'.monitor-row{display:flex;align-items:center;gap:8px;padding:3px 0 3px 12px;}',
'.monitor-row__dot{width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0;}',
'.monitor-row__dot--active{background:#4caf50;}',
'.monitor-row__dot--error{background:#f44336;}',
'.monitor-row__name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
'.monitor-row__meta{color:var(--txt-2);font-size:11px;white-space:nowrap;}',
```

- [ ] **Step 3: Add monitor surface DOM in `buildWorkbench()` in `wc-shell.ts`**

In the `buildWorkbench` function (after the `memorySurfaceHost` block, before `browserSurface`):

```typescript
const monitorSurfaceHost = el('slicc-surface', { 'surface-id': 'monitor', layout: 'flex' });
const monitorHost = el('div', { class: 'wcui-monitor' });
monitorSurfaceHost.append(monitorHost);
```

Update the `body.append(...)` call to include `monitorSurfaceHost`:

```typescript
body.append(filesSurface, termSurfaceHost, memorySurfaceHost, monitorSurfaceHost, browserSurface);
```

Update the return statement to include `monitorHost`:

```typescript
return { workbench, body, header, tree, termSurface, memoryHost, monitorHost, tabBar: tabs };
```

- [ ] **Step 4: Add `monitorHost` to `WcShellRefs` in `wc-shell.ts`**

Add to the `WcShellRefs` interface:

```typescript
monitorHost: HTMLElement;
```

And in `mountWcShell`, add `monitorHost` to the returned refs object (it comes from `buildWorkbench()`'s return).

- [ ] **Step 5: Add monitor activation handler in `wc-workbench.ts`**

Add import at top:

```typescript
import { buildMonitorSections, type MonitorDeps } from './wc-monitor.js';
```

Add `monitorHost` and `getMonitorDeps` to `WcWorkbenchDeps`:

```typescript
export interface WcWorkbenchDeps {
  fileTree: SliccFileTree;
  termSurface: HTMLElement;
  memoryHost: HTMLElement;
  monitorHost: HTMLElement;
  openFs(): Promise<LocalVfsClient>;
  getMonitorDeps(): MonitorDeps;
  mountTerminal(container: HTMLElement): Promise<void>;
  log: { error(message: string, ...data: unknown[]): void };
}
```

Add the monitor case in `createWorkbenchActivator`, after the memory case:

```typescript
if (surfaceId === 'monitor') {
  void (async () => {
    try {
      const root = await buildMonitorSections(deps.getMonitorDeps());
      deps.monitorHost.replaceChildren(root);
    } catch (err) {
      deps.log.error('WC monitor refresh failed', err);
    }
  })();
  return;
}
```

- [ ] **Step 6: Wire monitor deps in `wc-live.ts`**

In `attachWcClient`, update the `createWorkbenchActivator` call (~line 1350):

```typescript
boot.setActivateSurface(
  createWorkbenchActivator({
    fileTree: refs.fileTree,
    termSurface: refs.termSurface,
    memoryHost: refs.memoryHost,
    monitorHost: refs.monitorHost,
    openFs: openReader,
    getMonitorDeps: () => ({
      getScoops: () => client.getScoops(),
      isProcessing: (jid: string) => client.isProcessing(jid),
      getCronTasks: async () => {
        const { getAllCronTasks } = await import('../../scoops/db.js');
        return getAllCronTasks();
      },
      getWebhooks: async () => {
        const { getAllWebhooks } = await import('../../scoops/db.js');
        return getAllWebhooks();
      },
      getMounts: async () => {
        const { getAllMountEntries } = await import('../../fs/mount-table-store.js');
        return getAllMountEntries();
      },
      getMcpServers: async () => {
        try {
          const fs = await openReader();
          const raw = await fs.readFile('/workspace/.mcp/servers.json', { encoding: 'utf-8' });
          const parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
          return parsed.servers ?? {};
        } catch {
          return {};
        }
      },
      getOAuthProviders: () => {
        try {
          const raw = localStorage.getItem('slicc_accounts');
          if (!raw) return [];
          const accounts = JSON.parse(raw);
          if (!Array.isArray(accounts)) return [];
          return [
            ...new Set(accounts.map((a: { providerId?: string }) => a.providerId).filter(Boolean)),
          ];
        } catch {
          return [];
        }
      },
    }),
    mountTerminal: (container) => mountWorkbenchTerminal(boot, client, container),
    log,
  })
);
```

Also add `monitorHost` to the `mountWcShell` return value destructuring. The `buildWorkbench` return already includes it from Step 3, and `mountWcShell` already spreads all workbench results into refs — but the `WcShellRefs` type guard (Step 4) requires the field to exist on the object returned from `mountWcShell`. Since `mountWcShell` returns ALL fields from `buildWorkbench` already (via its `return { ... }` at line ~378-400), adding `monitorHost` to the `buildWorkbench` return (Step 3) and the `WcShellRefs` interface (Step 4) is sufficient.

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS — no type errors

- [ ] **Step 8: Run tests**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-monitor.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add packages/webapp/src/ui/wc/wc-sprinkles.ts packages/webapp/src/ui/wc/wc-shell.ts packages/webapp/src/ui/wc/wc-workbench.ts packages/webapp/src/ui/wc/wc-live.ts
git commit -m "feat(webapp): wire monitor tab into workbench as built-in surface"
```

---

### Task 3: Verify end-to-end — typecheck, lint, existing tests pass

**Files:**

- No new files — verification only

**Interfaces:**

- Consumes: All changes from Tasks 1-2
- Produces: Passing CI gates

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: PASS (or fix any lint issues from new code)

- [ ] **Step 2: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS for all five typecheck targets

- [ ] **Step 3: Run webapp tests**

Run: `npm run test -w @slicc/webapp`
Expected: ALL PASS — no regressions in existing wc tests

- [ ] **Step 4: Run build**

Run: `npm run build -w @slicc/webapp`
Expected: PASS — the new module bundles without errors

- [ ] **Step 5: Fix any issues found and commit**

```bash
git add -u
git commit -m "fix(webapp): address lint/type/test issues from monitor tab integration"
```

(Skip this commit if no fixes needed.)
