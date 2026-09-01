// packages/webapp/tests/e2e/two-instance-helpers.ts
/**
 * Two-instance (leader + follower) topology helpers for the fake-LLM E2E
 * harness — the multiple-cones scenarios of #2313, and anything later that
 * needs a second SLICC runtime.
 *
 * The topology is the production standalone one, twice over:
 *
 *   - **leader** — the `page` fixture, booted through {@link bootMultiConeLeader}:
 *     wrangler serves the UI (`baseURL`), the node-server thin bridge answers
 *     `/cdp` + `/api`, and the fake OpenAI-compatible server is the provider.
 *     `?trayWorkerUrl=` points its tray at the SAME wrangler instance, which is
 *     the real `packages/cloudflare-worker` — a real tray hub with real Durable
 *     Objects, not a stub.
 *   - **follower** — a SECOND browser context (its own profile, so its own
 *     `localStorage` and its own Web Locks: the leader election in `wc-tray.ts`
 *     is per-origin-per-profile and would otherwise see one tab) navigated to
 *     the leader's `…/join/<token>` URL. The worker serves the SPA there and
 *     the boot path detects follower mode from the path itself
 *     (`resolveFollowerJoinUrl`), so nothing has to be seeded.
 *
 * A follower joined this way is a *UI* follower: it has no local CDP surface
 * and cannot host a teleported tab (see
 * `.agents/skills/cdp-smoke-test/tier3-multi-harness.md`). That is exactly what
 * the cone scenarios need — tabs, ordering, model selection, read-only scoops —
 * and nothing more.
 *
 * Ports come from `playwright.config.ts`, i.e. the `SLICC_E2E_*` overrides, so
 * a local run never collides with a live 5710/9222/8787 stack.
 */

import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  loadFakeLlmFixture,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { leaderBootQuery, seedSkipSwReload } from './helpers.js';
import { LEADER_ORIGIN } from './playwright.config.js';

/**
 * Per-test budget for a cone scenario. A cone lifecycle is several real turns
 * plus VFS round-trips, and CI is roughly 6× slower than a laptop at the object
 * construction underneath all of it — the config's 30s default is nowhere near.
 */
export const CONE_TEST_TIMEOUT_MS = 300_000;

/**
 * Budget for a spec that runs TWO runtimes over a real tray. It is not the
 * single-runtime budget with slack: a healthy CI run of the follower scenario
 * takes ~1.5 min against ~10 s locally, so the ceiling has to absorb a loaded
 * runner rather than merely a slow one — 300 s left too little headroom and
 * dropped the PR out of the merge queue.
 */
export const TWO_INSTANCE_TEST_TIMEOUT_MS = 600_000;

/** Navigation budget for a boot / join. */
const NAV_TIMEOUT_MS = 60_000;

/** Budget for a single UI action (a tab click). */
const ACTION_TIMEOUT_MS = 30_000;

/** Model id every multi-cone fixture advertises and every cone runs on. */
export const CONE_MODEL = 'fake-cone-primary';
/** Second advertised model, so a follower has something to switch cone B to. */
export const CONE_MODEL_ALT = 'fake-cone-alternate';
/** Provider the fake models are registered under (`built-in/local-llm.ts`). */
const LOCAL_LLM_PROVIDER_ID = 'local-llm';

/** localStorage key of the feature-flag override bag (`core/feature-flags.ts`). */
const FEATURE_FLAG_STORAGE_KEY = 'slicc_feature_flags';
/** localStorage key the page mirrors leader tray status into (`base/tray-role.ts`). */
const LEADER_STATUS_STORAGE_KEY = 'slicc.leaderTrayStatus';

/** Label of the primary cone's tab — `assistantLabel` of the bootstrapped root. */
export const PRIMARY_CONE_LABEL = 'sliccy';

/**
 * Turn the `multiple-cones` flag on before boot. The flag is read once during
 * boot (`initFeatureFlags`), so this has to be an init script rather than a
 * post-`goto` write.
 */
export async function seedFeatureFlags(
  page: Page,
  flags: Readonly<Record<string, string>>
): Promise<void> {
  await page.addInitScript(
    (seed: { key: string; value: string }) => {
      try {
        localStorage.setItem(seed.key, seed.value);
      } catch {
        /* localStorage may be unavailable for opaque origins */
      }
    },
    { key: FEATURE_FLAG_STORAGE_KEY, value: JSON.stringify(flags) }
  );
}

export interface BootLeaderOptions {
  /** Fixture object POSTed to the fake server's `/__fixture` before boot. */
  fixture: unknown;
  /** Model id to seed as the selected one. Defaults to {@link CONE_MODEL}. */
  modelId?: string;
  /**
   * Every model the account advertises. Defaults to BOTH fake models, so a
   * scenario can move a cone from one to the other without a Settings trip.
   */
  modelIds?: readonly string[];
  /**
   * Point the page's tray at the harness's own wrangler (`?trayWorkerUrl=`) so
   * the leader mints a tray on the LOCAL worker and a follower can join it.
   * Off by default: a leader-only scenario should not pay for a tray.
   */
  tray?: boolean;
}

/**
 * Boot the leader with the fake LLM, the `multiple-cones` flag and (optionally)
 * a local tray, and wait until the bootstrapped primary cone is selected.
 *
 * The welcome message is the readiness signal, exactly as in
 * `reference-scenario.test.ts`: the composer renders before the kernel worker
 * finishes the cone bootstrap, and a message submitted in that window dies with
 * "No scoop selected".
 */
export async function bootMultiConeLeader(page: Page, options: BootLeaderOptions): Promise<void> {
  await loadFakeLlmFixture(options.fixture);
  await seedLocalLlmProvider(page, {
    modelId: options.modelId ?? CONE_MODEL,
    modelIds: options.modelIds ?? [CONE_MODEL, CONE_MODEL_ALT],
  });
  await seedFeatureFlags(page, { 'multiple-cones': 'on' });
  await seedSkipSwReload(page);
  // The thin-bridge params are NOT optional, however little a cone scenario
  // looks like browser automation: the kernel worker routes provider fetches
  // through node-server's proxy, so without them the first turn dies with
  // `404 "Fetch proxy not available in worker mode"`. Measured, not assumed —
  // dropping them failed all four specs in one run.
  const query = new URLSearchParams(leaderBootQuery());
  // `?trayWorkerUrl=` beats the stored value AND the node-server's
  // `/api/runtime-config` (see `resolveTrayRuntimeConfig`), which would
  // otherwise point the tray at the production hub.
  if (options.tray) query.set('trayWorkerUrl', LEADER_ORIGIN);
  // Every navigation and action in this file carries an explicit timeout.
  // Playwright's defaults are 0 (unbounded, cut off only by the TEST timeout),
  // which is how a stuck step reports itself as a bare "Test timeout of Nms
  // exceeded" with no indication of where it was — exactly the CI failure this
  // rule exists to prevent.
  await page.goto(`/?${query.toString()}`, { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('slicc-input-card', { timeout: NAV_TIMEOUT_MS });
  await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
    timeout: 30_000,
  });
}

/**
 * Turn multi-browser sync on, the way the avatar menu's "Enable multi-browser
 * sync" item does: a `slicc:tray-leave` window event carrying the worker base
 * URL, which `wc-tray.ts` handles by restarting this tab as a tray leader.
 *
 * Boot does NOT mint a tray on its own — a standalone profile that never joined
 * or enabled sync stays role-less (`startInitialRole` needs a stored join URL or
 * a stored worker URL AND the user's intent). `?trayWorkerUrl=` supplies the
 * URL; this supplies the intent.
 *
 * A no-op once the tray is up, so it is safe to call before every
 * {@link leaderJoinUrl}.
 */
export async function enableTraySync(page: Page, workerBaseUrl = LEADER_ORIGIN): Promise<void> {
  const alreadyLeader = await page.evaluate((key: string) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as { state?: string }).state !== 'inactive' : false;
    } catch {
      return false;
    }
  }, LEADER_STATUS_STORAGE_KEY);
  if (alreadyLeader) return;
  await page.evaluate((url: string) => {
    window.dispatchEvent(new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl: url } }));
  }, workerBaseUrl);
}

/**
 * The join URL of the leader's tray, enabling sync first if it is not already
 * on. Read from the `localStorage` shim the page keeps current
 * (`slicc.leaderTrayStatus`) rather than from a module global, because
 * `LeaderTrayManager` runs in the page realm and the test does not.
 */
export async function leaderJoinUrl(page: Page, timeoutMs = 45_000): Promise<string> {
  await enableTraySync(page);
  const handle = await page.waitForFunction(
    (key: string) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { state?: string; session?: { joinUrl?: string } };
        return parsed.state === 'leader' && parsed.session?.joinUrl ? parsed.session.joinUrl : null;
      } catch {
        return null;
      }
    },
    LEADER_STATUS_STORAGE_KEY,
    { timeout: timeoutMs }
  );
  return (await handle.jsonValue()) as string;
}

export interface FollowerHandle {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Join the leader's tray from a second browser context and wait until the
 * follower's tab strip has been populated from the leader's roster.
 *
 * A separate context — not just a second page — is what makes this a second
 * *runtime*: `wc-tray.ts` elects one leader per origin per profile through the
 * Web Locks API, so a second page in the leader's own context would defer
 * instead of following.
 */
export async function joinAsFollower(
  browser: Browser,
  joinUrl: string,
  options: { timeoutMs?: number } = {}
): Promise<FollowerHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(joinUrl, { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('slicc-agent-tabs', { timeout: options.timeoutMs ?? 45_000 });
  // The strip is empty until the first `scoops.list` lands over the tray.
  await expect
    .poll(() => switcherLabels(page), { timeout: options.timeoutMs ?? 45_000 })
    .not.toEqual([]);
  return {
    context,
    page,
    close: async () => {
      await context.close();
    },
  };
}

/**
 * Boot a SECOND, INDEPENDENT SLICC runtime — its own leader on the same tray
 * hub, not a follower of the first.
 *
 * The distinction matters for anything testing `slicc` sidecar attachments:
 * {@link joinAsFollower} produces a runtime that has GIVEN UP its own role to
 * mirror the leader, which is precisely the state a sidecar must not require.
 * This one keeps its own tray, so a test can assert that attaching left it
 * alone.
 *
 * A separate browser context for the same reason as `joinAsFollower`: leader
 * election in `wc-tray.ts` is per-origin-per-profile, so a second page in the
 * first context would defer to it instead of leading.
 */
export async function bootSecondLeader(
  browser: Browser,
  options: BootLeaderOptions
): Promise<FollowerHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await bootMultiConeLeader(page, options);
  return { context, page, close: async () => await context.close() };
}

// ── Tab strip ──────────────────────────────────────────────────────

/**
 * The tab strip's labels, in render order: cones (oldest first), then the
 * selected cone's scoops, then everyone else's (`orderForSwitcher` on the
 * leader, `toFollowerSwitcherScoops` on the follower — the assertion that the
 * two agree is the point of the follower scenario).
 *
 * The segments live in `<slicc-agent-tabs>`'s LIGHT DOM, so a plain locator
 * reads them; overflowed segments carry `.hide` but stay in the DOM, which is
 * what keeps the order assertion independent of the viewport width.
 */
export async function switcherLabels(page: Page): Promise<string[]> {
  return page.locator('slicc-agent-tabs .slicc-agent-tabs__label').allTextContents();
}

/** Click the tab whose label matches exactly. */
export async function selectTab(page: Page, label: string): Promise<void> {
  await page
    .locator('slicc-agent-tabs .slicc-agent-tabs__segment')
    .filter({ has: page.locator('.slicc-agent-tabs__label', { hasText: exact(label) }) })
    .first()
    .click({ timeout: ACTION_TIMEOUT_MS });
}

/** The label of the currently selected tab (`active` attribute → descriptor). */
export async function activeTabLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const tabs = document.querySelector('slicc-agent-tabs') as
      | (HTMLElement & { scoops?: Array<{ key: string; label?: string }> })
      | null;
    const active = tabs?.getAttribute('active');
    if (!tabs || !active) return null;
    return tabs.scoops?.find((scoop) => scoop.key === active)?.label ?? null;
  });
}

function exact(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// ── Freezer rail: cone + session actions ───────────────────────────

/**
 * Expand the freezer rail. The action row (`new chat` / `fast` / `discard` /
 * `new cone` / `drop cone`) only exists in the expanded rail — collapsed, the
 * single badge's press gesture is the only affordance — so every rail action
 * helper below goes through here first. `toggle(true)` is the component's own
 * API and propagates `expanded` onto `<slicc-freezer-new>`, which a bare
 * `setAttribute('open')` would not.
 */
export async function expandFreezerRail(page: Page): Promise<void> {
  await page.waitForSelector('slicc-freezer slicc-freezer-new', { timeout: ACTION_TIMEOUT_MS });
  await page.evaluate(() => {
    const freezer = document.querySelector('slicc-freezer') as
      | (HTMLElement & { toggle?: (force?: boolean) => void })
      | null;
    freezer?.toggle?.(true);
  });
  await expect(page.locator('slicc-freezer-new')).toHaveAttribute('expanded', '');
}

/** One of the five action-row buttons of `<slicc-freezer-new>`. */
export type RailAction =
  | 'new-chat-save'
  | 'new-chat-skip'
  | 'new-chat-erase'
  | 'new-cone'
  | 'drop-cone';

/** Locator for a rail action button (inside the row's open shadow root). */
export function railAction(page: Page, action: RailAction): Locator {
  return page.locator(`slicc-freezer-new .fznew-act--${action}`);
}

/** Click a rail action, expanding the rail first if it is still collapsed. */
export async function clickRailAction(page: Page, action: RailAction): Promise<void> {
  await expandFreezerRail(page);
  await railAction(page, action).click({ timeout: ACTION_TIMEOUT_MS });
}

/** The `<slicc-dialog>` a cone action opened (New cone / Drop cone). */
export function coneDialog(page: Page): Locator {
  return page.locator('slicc-dialog[heading]');
}

/**
 * Create a cone through the rail: New cone → fill the dialog → Create. When a
 * `brief` is given the cone starts its first turn on it immediately, so the
 * caller usually wants a fixture turn matching that text.
 */
export async function createCone(
  page: Page,
  cone: { name: string; brief?: string }
): Promise<void> {
  await clickRailAction(page, 'new-cone');
  // The `<slicc-dialog>` host itself has no box (its chrome lives in the
  // shadow root), so visibility is asserted on the fields it slots.
  const dialog = coneDialog(page).filter({ hasText: 'New cone' });
  const name = dialog.locator('input[name="name"]');
  await expect(name).toBeVisible();
  await name.fill(cone.name);
  if (cone.brief) await dialog.locator('textarea[name="brief"]').fill(cone.brief);
  await dialog.locator('button[data-cone-action="create"]').click();
  await expect.poll(() => switcherLabels(page), { timeout: 30_000 }).toContain(cone.name);
}

/** Drop the selected cone through the rail: Drop cone → confirm. */
export async function dropSelectedCone(page: Page, label: string): Promise<void> {
  await clickRailAction(page, 'drop-cone');
  const dialog = coneDialog(page).filter({ hasText: `Drop ${label}?` });
  const confirm = dialog.locator('button[data-cone-action="drop"]');
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect.poll(() => switcherLabels(page), { timeout: 30_000 }).not.toContain(label);
}

// ── Freezer cards ──────────────────────────────────────────────────

/** Titles of the frozen-chat cards currently on the rail, top card first. */
export async function freezerCardTitles(page: Page): Promise<string[]> {
  return page
    .locator('slicc-freezer slicc-freezer-card')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('title') ?? ''));
}

/** Open a frozen chat by card title (the read-only thaw view). */
export async function openFreezerCard(page: Page, title: string): Promise<void> {
  await page
    .locator(`slicc-freezer slicc-freezer-card[title="${title}"]`)
    .click({ timeout: ACTION_TIMEOUT_MS });
}

/**
 * The freezer index (`/sessions/index.json`) as the worker VFS holds it —
 * where `memorySkipped` lives. Read through the terminal seam the speech E2E
 * uses (`__slicc_terminal_view`), because it is the only page-side handle on
 * the worker's filesystem that does not require booting a second VFS client.
 */
export async function readFreezerIndex(
  page: Page
): Promise<Array<{ filename: string; title: string; cone?: string; memorySkipped?: boolean }>> {
  const raw = await execInTerminal(page, 'cat /sessions/index.json');
  if (raw.exitCode !== 0) return [];
  try {
    return JSON.parse(raw.stdout) as Array<{ filename: string; title: string }>;
  } catch {
    return [];
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

declare global {
  interface Window {
    /** Published by `mountWorkbenchTerminal` once the term surface is live. */
    __slicc_terminal_view?: {
      executeCommandInTerminal(cmd: string): Promise<ExecResult>;
    };
  }
}

/**
 * Run one command in the workbench terminal through the page-side
 * `RemoteTerminalView` published on `globalThis.__slicc_terminal_view` — the
 * same programmatic seam the chat panel's "run in terminal" affordance uses.
 * The view is published by a lazy mount, so the helper waits for it.
 */
export async function execInTerminal(
  page: Page,
  command: string,
  timeoutMs = 90_000
): Promise<ExecResult> {
  await openTerminal(page, timeoutMs);
  return page.evaluate(async (cmd: string) => {
    const view = (
      globalThis as {
        __slicc_terminal_view?: { executeCommandInTerminal(c: string): Promise<ExecResult> };
      }
    ).__slicc_terminal_view;
    if (!view) throw new Error('terminal view not published yet');
    return view.executeCommandInTerminal(cmd);
  }, command);
}

/**
 * Mount the workbench terminal and wait for its programmatic view.
 *
 * `mountWorkbenchTerminal` is LAZY: the view only appears once the term
 * surface has been activated, so a bare wait on the global times out on a
 * shell that never opened one. `selectItem('term')` is the dock rail's
 * documented entry point (it fires `slicc-dock-select`, which opens the
 * workbench and triggers the mount) — the same sequence `speech-roundtrip`
 * and `git-clone-live` use.
 *
 * Idempotent, so callers can treat it as "make sure there is a terminal".
 */
export async function openTerminal(page: Page, timeoutMs = 90_000): Promise<void> {
  if (await page.evaluate(() => Boolean(window.__slicc_terminal_view))) return;
  await page.evaluate(() => {
    const dock = document.querySelector('slicc-dock') as
      | (HTMLElement & { selectItem?: (id: string) => void })
      | null;
    if (!dock?.selectItem) throw new Error('<slicc-dock>.selectItem(id) unavailable');
    dock.selectItem('term');
  });
  // 90s, not 30/60: the lazy mount (dynamic import + session handshake) regularly
  // exceeds half a minute on a loaded CI runner. Specs that still wait only 30s
  // (python-print, git-clone-live) turn that into a red run; this helper is the
  // shared entry point so every caller inherits the corrected budget.
  await page.waitForFunction(() => window.__slicc_terminal_view != null, null, {
    timeout: timeoutMs,
  });
}

// ── Chat ───────────────────────────────────────────────────────────

/** The chat thread's rendered text — what "landed in this cone" means. */
export function thread(page: Page): Locator {
  return page.locator('slicc-chat-thread');
}

/** True when a composer is mounted and enabled (a scoop view has neither). */
export async function composerIsUsable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const card = document.querySelector('slicc-input-card');
    if (!card) return false;
    return !card.hasAttribute('disabled');
  });
}

// ── Model pill ─────────────────────────────────────────────────────

/**
 * The model the composer's meta pill is showing — the selected cone's model
 * once #2310 landed, and the one global selection before it. `local-llm`
 * names a model after its id (`getModelIds` in `built-in/local-llm.ts`), so
 * this reads back as the fixture's model id on both sides.
 */
export async function modelPill(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const meta = document.querySelector('slicc-composer-meta');
    return meta?.getAttribute('model') ?? null;
  });
}

/**
 * Pick a model on the FOLLOWER through `<slicc-composer-meta>`'s public
 * contract — the `model-change` event `createFollowerModelSurface` listens
 * for, which forwards `model.select` (with the follower's selected cone as
 * `scoopJid`, #2310) over the tray. Driving the event rather than the menu
 * keeps the assertion about the wire, not about a popover's geometry.
 *
 * Takes a BARE model id and qualifies it: the tray catalog keys models
 * `<providerId>:<modelId>` (`modelCatalogForTray`), and a leader ignores a
 * `model.select` whose id is not in the catalog it advertised.
 */
export async function followerSelectModel(page: Page, modelId: string): Promise<void> {
  // Wait for the pill to be ATTACHED, not visible.
  //
  // It is tempting to wait for it to render — a hidden pill means the follower
  // has no catalog, which feels like "not ready". But the pick does not go
  // through the rendered surface at all: `createFollowerModelSurface`'s
  // `model-change` listener forwards `sync.selectModel(modelId, scoopJid)`
  // unconditionally, taking the target from `getSelectedScoopJid()` — the tab
  // this test already selected and asserted. Gating on visibility coupled a
  // #2310 assertion (does the leader move the right cone?) to the #2329
  // rendering path (does the follower's catalog arrive?), and CI fails the
  // latter while the former works: the leader-side assertions below passed the
  // moment this wait was removed. The catalog's own behaviour is covered by
  // unit tests in `wc-tray-model-per-cone.test.ts`, where it is deterministic.
  await page.locator('slicc-composer-meta').waitFor({
    state: 'attached',
    timeout: ACTION_TIMEOUT_MS,
  });
  await page.evaluate((id: string) => {
    const meta = document.querySelector('slicc-composer-meta');
    if (!meta) throw new Error('slicc-composer-meta not mounted');
    meta.dispatchEvent(
      new CustomEvent('model-change', { detail: { id }, bubbles: true, composed: true })
    );
  }, `${LOCAL_LLM_PROVIDER_ID}:${modelId}`);
}

/**
 * One user turn in the selected cone: submit, wait for the scripted reply to
 * render, then let the turn settle.
 *
 * The REPLY is the signal, not `[data-processing]`: a fake-LLM turn can open
 * and close between two polls of the attribute, so `mustObserveTurnRise` would
 * fail a turn that in fact ran perfectly (observed: the whole tool call and its
 * follow-up landed inside the same wall-clock second). Asserting the scripted
 * text is a positive signal that cannot pass without the turn having happened.
 */
export async function chat(page: Page, prompt: string, expectedReply: string): Promise<void> {
  await submitUserMessage(page, prompt);
  await expectReply(page, expectedReply);
  await waitForTurnComplete(page, { timeoutMs: 60_000, riseTimeoutMs: 1_000 });
}

/**
 * Wait for a scripted reply — or for the turn to fail, whichever happens first.
 *
 * A turn that dies (provider error, fixture overflow, retries exhausted)
 * renders a `<slicc-error-card>` and NEVER renders the expected text, so a bare
 * `toContainText` would sit there until the test-level timeout and report
 * "Test timeout exceeded" with no cause — which is precisely how this spec
 * burned three 5-minute CI attempts without saying what went wrong. Racing the
 * two turns that silence into a message naming the agent error.
 */
export async function expectReply(
  page: Page,
  expectedReply: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await thread(page).getByText(expectedReply, { exact: false }).count()) return;
    const failure = await agentErrorText(page);
    if (failure) {
      throw new Error(
        `expectReply: the turn failed before rendering ${JSON.stringify(expectedReply)} — ` +
          `the thread shows an error card: ${failure}`
      );
    }
    await page.waitForTimeout(250);
  }
  // Let Playwright produce its usual diff / snapshot for the timeout case.
  await expect(thread(page)).toContainText(expectedReply, { timeout: 1_000 });
}

/** Text of the first agent-error card in the thread, if the turn failed. */
async function agentErrorText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const card = document.querySelector('slicc-chat-thread slicc-error-card');
    if (!card) return null;
    return card.getAttribute('message') ?? card.textContent?.trim() ?? 'unknown error';
  });
}

// ── Diagnostics ────────────────────────────────────────────────────

export interface BrowserDiagnostics {
  /** Every captured line, oldest first, prefixed with its runtime label. */
  entries: string[];
  /**
   * Re-throw helper: returns the error with the captured console tail
   * appended. A two-instance failure is otherwise reported as a bare Playwright
   * timeout, with the actual cause (an agent error, a dropped tray socket)
   * visible only in a 190 MB trace artifact nobody downloads.
   */
  annotate(err: unknown): Error;
}

/**
 * Capture the console lines that explain a two-instance failure: errors and
 * warnings from either runtime, plus anything the agent / tray / CDP layers
 * say. Pass an existing {@link BrowserDiagnostics} as `into` to fold a second
 * runtime's output into one ordered log.
 */
export function watchBrowserDiagnostics(
  page: Page,
  label: string,
  into?: BrowserDiagnostics
): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = into ?? {
    entries: [],
    annotate(err: unknown): Error {
      const error = err instanceof Error ? err : new Error(String(err));
      const tail = diagnostics.entries.slice(-40).join('\n');
      error.message = `${error.message}\n--- browser diagnostics (last 40) ---\n${
        tail || '(nothing captured)'
      }`;
      return error;
    },
  };
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning' || /(scoop|tray|cdp|model|lick)/i.test(msg.text())) {
      diagnostics.entries.push(`[${label}.${type}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => diagnostics.entries.push(`[${label}.pageerror] ${err.message}`));
  return diagnostics;
}
