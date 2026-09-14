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

export const CONE_TEST_TIMEOUT_MS = 300_000;

export const TWO_INSTANCE_TEST_TIMEOUT_MS = 600_000;

const NAV_TIMEOUT_MS = 60_000;

const ACTION_TIMEOUT_MS = 30_000;

const SELECT_RETRY_WINDOW_MS = 15_000;

export const CONE_MODEL = 'fake-cone-primary';

export const CONE_MODEL_ALT = 'fake-cone-alternate';

const LOCAL_LLM_PROVIDER_ID = 'local-llm';

const LEADER_STATUS_STORAGE_KEY = 'slicc.leaderTrayStatus';

export const PRIMARY_CONE_LABEL = 'sliccy';

export interface BootLeaderOptions {
  fixture: unknown;

  modelId?: string;

  modelIds?: readonly string[];

  tray?: boolean;
}

export async function bootMultiConeLeader(page: Page, options: BootLeaderOptions): Promise<void> {
  await loadFakeLlmFixture(options.fixture);
  await seedLocalLlmProvider(page, {
    modelId: options.modelId ?? CONE_MODEL,
    modelIds: options.modelIds ?? [CONE_MODEL, CONE_MODEL_ALT],
  });
  await seedSkipSwReload(page);

  const query = new URLSearchParams(leaderBootQuery());

  if (options.tray) query.set('trayWorkerUrl', LEADER_ORIGIN);

  await page.goto(`/?${query.toString()}`, { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('slicc-input-card', { timeout: NAV_TIMEOUT_MS });
  await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
    timeout: 30_000,
  });
}

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

export async function joinAsFollower(
  browser: Browser,
  joinUrl: string,
  options: { timeoutMs?: number } = {}
): Promise<FollowerHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(joinUrl, { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('slicc-agent-tabs', { timeout: options.timeoutMs ?? 45_000 });

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

export async function bootSecondLeader(
  browser: Browser,
  options: BootLeaderOptions
): Promise<FollowerHandle> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await bootMultiConeLeader(page, options);
  return { context, page, close: async () => await context.close() };
}

export async function switcherLabels(page: Page): Promise<string[]> {
  return page.locator('slicc-agent-tabs .slicc-agent-tabs__label').allTextContents();
}

export async function selectTab(page: Page, label: string): Promise<void> {
  await page
    .locator('slicc-agent-tabs .slicc-agent-tabs__segment')
    .filter({ has: page.locator('.slicc-agent-tabs__label', { hasText: exact(label) }) })
    .first()
    .click({ timeout: ACTION_TIMEOUT_MS });
}

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

export type RailAction =
  | 'new-chat-save'
  | 'new-chat-skip'
  | 'new-chat-erase'
  | 'new-cone'
  | 'drop-cone';

export function railAction(page: Page, action: RailAction): Locator {
  return page.locator(`slicc-freezer-new .fznew-act--${action}`);
}

export async function clickRailAction(page: Page, action: RailAction): Promise<void> {
  await expandFreezerRail(page);
  await railAction(page, action).click({ timeout: ACTION_TIMEOUT_MS });
}

export function coneDialog(page: Page): Locator {
  return page.locator('slicc-dialog[heading]');
}

export async function createCone(
  page: Page,
  cone: { name: string; brief?: string }
): Promise<void> {
  await clickRailAction(page, 'new-cone');

  const dialog = coneDialog(page).filter({ hasText: 'New cone' });
  const name = dialog.locator('input[name="name"]');
  await expect(name).toBeVisible();
  await name.fill(cone.name);
  if (cone.brief) await dialog.locator('textarea[name="brief"]').fill(cone.brief);
  await dialog.locator('button[data-cone-action="create"]').click();
  await expect.poll(() => switcherLabels(page), { timeout: 30_000 }).toContain(cone.name);
}

export async function dropSelectedCone(page: Page, label: string): Promise<void> {
  await clickRailAction(page, 'drop-cone');
  const dialog = coneDialog(page).filter({ hasText: `Drop ${label}?` });
  const confirm = dialog.locator('button[data-cone-action="drop"]');
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect.poll(() => switcherLabels(page), { timeout: 30_000 }).not.toContain(label);
}

export async function freezerCardTitles(page: Page): Promise<string[]> {
  return page
    .locator('slicc-freezer slicc-freezer-card')
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('title') ?? ''));
}

export async function openFreezerCard(page: Page, title: string): Promise<void> {
  await page
    .locator(`slicc-freezer slicc-freezer-card[title="${title}"]`)
    .click({ timeout: ACTION_TIMEOUT_MS });
}

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
    __slicc_terminal_view?: {
      executeCommandInTerminal(cmd: string): Promise<ExecResult>;
    };
  }
}

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

export async function openTerminal(page: Page, timeoutMs = 90_000): Promise<void> {
  if (await page.evaluate(() => Boolean(window.__slicc_terminal_view))) return;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await page.evaluate(() => {
      const dock = document.querySelector('slicc-dock') as
        | (HTMLElement & { selectItem?: (id: string) => void })
        | null;
      if (!dock?.selectItem) throw new Error('<slicc-dock>.selectItem(id) unavailable');
      dock.selectItem('term');
    });
    try {
      await page.waitForFunction(() => window.__slicc_terminal_view != null, null, {
        timeout: Math.min(SELECT_RETRY_WINDOW_MS, Math.max(1_000, deadline - Date.now())),
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `__slicc_terminal_view was never published within ${timeoutMs}ms ` +
      `(re-selected the term surface until the deadline): ${String(lastError)}`
  );
}

export function thread(page: Page): Locator {
  return page.locator('slicc-chat-thread');
}

export async function composerIsUsable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const card = document.querySelector('slicc-input-card');
    if (!card) return false;
    return !card.hasAttribute('disabled');
  });
}

export async function modelPill(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const meta = document.querySelector('slicc-composer-meta');
    return meta?.getAttribute('model') ?? null;
  });
}

export async function followerSelectModel(page: Page, modelId: string): Promise<void> {
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

export async function chat(page: Page, prompt: string, expectedReply: string): Promise<void> {
  await submitUserMessage(page, prompt);
  await expectReply(page, expectedReply);
  await waitForTurnComplete(page, { timeoutMs: 60_000, riseTimeoutMs: 1_000 });
}

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

  await expect(thread(page)).toContainText(expectedReply, { timeout: 1_000 });
}

async function agentErrorText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const card = document.querySelector('slicc-chat-thread slicc-error-card');
    if (!card) return null;
    return card.getAttribute('message') ?? card.textContent?.trim() ?? 'unknown error';
  });
}

export interface BrowserDiagnostics {
  entries: string[];

  annotate(err: unknown): Error;
}

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
