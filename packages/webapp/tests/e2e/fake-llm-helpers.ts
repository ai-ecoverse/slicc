// packages/webapp/tests/e2e/fake-llm-helpers.ts
/**
 * Playwright helpers for driving the WC shell against the fake LLM
 * server (see `./fake-llm/server.ts`). Pairs with the second `webServer`
 * entry in `./playwright.config.ts`.
 *
 * Provides:
 *   - {@link seedLocalLlmProvider}    — `addInitScript` that seeds
 *     `slicc_accounts` + `selected-model` in `localStorage` before boot,
 *     pointing the `local-llm` provider at the fake server.
 *   - {@link submitUserMessage}       — drives the `<slicc-input-card>`
 *     submit path the host listens for.
 *   - {@link waitForTurnComplete}     — waits for the WC shell's
 *     `[data-processing]` rising-then-falling edge that marks a turn
 *     boundary.
 *   - {@link runUserInputFixture}     — sequences multiple
 *     submit→waitForTurnComplete pairs.
 *   - {@link readCdpPageState}        — enumerates page targets via
 *     Chrome's HTTP CDP discovery, for asserting on tabs the agent
 *     drove via the `open` shell command.
 *
 * The helpers do NOT depend on each other beyond the import surface
 * here, so individual scenarios can pick and choose.
 */

import type { Page } from '@playwright/test';
import { FAKE_LLM_PORT } from './playwright.config.js';

/** Default base URL the fake LLM webServer listens on. */
export const FAKE_LLM_BASE_URL = `http://127.0.0.1:${FAKE_LLM_PORT}/v1`;

/**
 * Rewind the fake LLM server's turn cursor + request counter so the
 * next request replays the scripted fixture from the top.
 *
 * The fake LLM is a long-lived Playwright `webServer` (see
 * `playwright.config.ts`) with a per-process cursor that advances on
 * every `/v1/chat/completions` call. Playwright retries spin up a fresh
 * worker but reuse that same server, so without a reset a retry would
 * resume mid-fixture and deterministically hit `fixture_overflow`. Call
 * this from a `beforeEach` (it runs before every attempt, including
 * retries) so each attempt starts deterministic.
 *
 * Runs in the Node test process, so it talks to the server's control
 * endpoint directly over `127.0.0.1`. Throws on a non-2xx response so a
 * misrouted reset surfaces loudly instead of silently leaking state.
 */
export async function resetFakeLlm(baseUrl: string = FAKE_LLM_BASE_URL): Promise<void> {
  const origin = baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${origin}/__reset`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`resetFakeLlm: HTTP ${res.status} resetting fake LLM at ${origin}/__reset`);
  }
}

/**
 * Swap the fake-LLM server's active fixture at runtime. The shared E2E
 * `webServer` boots with the default reference-scenario fixture; a test whose
 * turns differ POSTs its own fixture object here (resetting the cursor). Throws
 * on a non-2xx response so a bad fixture surfaces loudly.
 */
export async function loadFakeLlmFixture(
  fixture: unknown,
  baseUrl: string = FAKE_LLM_BASE_URL
): Promise<void> {
  const origin = baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${origin}/__fixture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixture),
  });
  if (!res.ok) {
    throw new Error(
      `loadFakeLlmFixture: HTTP ${res.status} loading fixture at ${origin}/__fixture`
    );
  }
}

/** Provider id of the built-in OpenAI-compat local provider. */
const LOCAL_LLM_PROVIDER_ID = 'local-llm';

/** localStorage keys mirrored from `src/providers/account-store.ts`. */
const ACCOUNTS_KEY = 'slicc_accounts';
const MODEL_KEY = 'selected-model';

export interface SeedLocalLlmOptions {
  /** Defaults to {@link FAKE_LLM_BASE_URL}. Must end in `/v1`. */
  baseUrl?: string;
  /** Model id to register + select. Matches the fake fixture's `model`. */
  modelId: string;
  /** Optional placeholder key. Local servers ignore it; pi-ai requires
   *  a non-empty string. Defaults to `'local'`. */
  apiKey?: string;
}

/**
 * Seed the `local-llm` account + selected-model pair into the page's
 * localStorage BEFORE boot. The webapp's account store reads these on
 * first paint, so the shell comes up with the fake server as the
 * active provider — no Settings dialog round-trip required.
 *
 * Call BEFORE `page.goto('/')` so the init script is in place when the
 * page document is created.
 */
export async function seedLocalLlmProvider(
  page: Page,
  options: SeedLocalLlmOptions
): Promise<void> {
  const baseUrl = options.baseUrl ?? FAKE_LLM_BASE_URL;
  const apiKey = options.apiKey ?? 'local';
  const { modelId } = options;
  await page.addInitScript(
    (seed: {
      providerId: string;
      apiKey: string;
      baseUrl: string;
      modelId: string;
      accountsKey: string;
      modelKey: string;
    }) => {
      try {
        const entry = {
          providerId: seed.providerId,
          apiKey: seed.apiKey,
          baseUrl: seed.baseUrl,
          deployment: seed.modelId,
        };
        localStorage.setItem(seed.accountsKey, JSON.stringify([entry]));
        localStorage.setItem(seed.modelKey, `${seed.providerId}:${seed.modelId}`);
      } catch {
        /* localStorage may be unavailable for opaque origins */
      }
    },
    {
      providerId: LOCAL_LLM_PROVIDER_ID,
      apiKey,
      baseUrl,
      modelId,
      accountsKey: ACCOUNTS_KEY,
      modelKey: MODEL_KEY,
    }
  );
}

/**
 * Submit a user message through the WC composer's public contract.
 *
 * Mirrors the real submit path: sets `<slicc-input-card>.value`, then
 * calls its `submit()` method, which dispatches the composed `submit`
 * CustomEvent the host listens for in `wc-live.ts`. The card's empty/
 * disabled guard is preserved — empty `text` is a no-op.
 *
 * Throws if the input card isn't mounted yet; callers should
 * `page.waitForSelector('slicc-input-card')` first.
 */
export async function submitUserMessage(page: Page, text: string): Promise<void> {
  await page.waitForSelector('slicc-input-card');
  await page.evaluate((value: string) => {
    const card = document.querySelector('slicc-input-card') as
      | (HTMLElement & { value?: string; submit?: () => void })
      | null;
    if (!card) throw new Error('slicc-input-card not found');
    if (typeof card.submit !== 'function') {
      throw new Error('slicc-input-card.submit() is unavailable');
    }
    card.value = value;
    card.submit();
  }, text);
}

export interface WaitForTurnOptions {
  /** Total wait budget in ms. Defaults to the Playwright test timeout. */
  timeoutMs?: number;
  /** How long to wait for the processing flag to RISE before assuming
   *  the turn never started (e.g. the model returned synchronously
   *  before observation). Defaults to 8000ms. */
  riseTimeoutMs?: number;
  /** When `true`, throw if `[data-processing]` never rises within
   *  `riseTimeoutMs`. Default `false` preserves the original "treat as
   *  already-finished" behaviour for fast fixtures. Set to `true` in
   *  tests where you depend on the turn actually streaming — otherwise
   *  a silent "turn never started" can pass as a false green. */
  mustObserveTurnRise?: boolean;
}

/**
 * Wait for a turn-boundary edge on the WC shell.
 *
 * The shell sets `[data-processing]` on `.wcui-frame` while a turn is
 * streaming (see `wc-live.ts`'s `onProcessingChange`). This helper
 * waits for the attribute to rise, then to fall again — the same
 * signal `onTurnComplete` hangs off internally.
 *
 * Invariant: by default, if `[data-processing]` never rises within
 * `riseTimeoutMs`, the helper assumes the turn already finished (or
 * never streamed) and returns successfully — making it safe to call
 * right after a fast fake-fixture turn. Callers that need the rise
 * to be observed (so a "turn never started" failure cannot pass
 * silently) MUST set `mustObserveTurnRise: true`, which makes the
 * helper throw instead of returning when no rise is seen.
 */
export async function waitForTurnComplete(
  page: Page,
  options: WaitForTurnOptions = {}
): Promise<void> {
  const rise = options.riseTimeoutMs ?? 8_000;
  const fallTimeout = options.timeoutMs ?? 20_000;

  await page.waitForSelector('.wcui-frame');

  const rose = await page
    .waitForFunction(
      () => document.querySelector('.wcui-frame')?.hasAttribute('data-processing') === true,
      undefined,
      { timeout: rise }
    )
    .then(() => true)
    .catch(() => false);
  if (!rose) {
    if (options.mustObserveTurnRise) {
      throw new Error(
        `waitForTurnComplete: [data-processing] never rose within ${rise}ms ` +
          `(mustObserveTurnRise=true). The turn likely never started — ` +
          `check that the user message was submitted and the fake LLM ` +
          `picked the expected fixture turn.`
      );
    }
    return;
  }

  await page.waitForFunction(
    () => document.querySelector('.wcui-frame')?.hasAttribute('data-processing') === false,
    undefined,
    { timeout: fallTimeout }
  );
}

/**
 * Drive an ordered list of user messages, awaiting turn completion
 * between each. Identical in effect to interleaving manual calls; the
 * helper exists so multi-turn fixtures stay declarative.
 */
export async function runUserInputFixture(
  page: Page,
  inputs: readonly string[],
  options: WaitForTurnOptions = {}
): Promise<void> {
  for (const input of inputs) {
    await submitUserMessage(page, input);
    await waitForTurnComplete(page, options);
  }
}

export interface CdpPageTarget {
  /** Stable CDP target id (key it back to `Target.attachToTarget`). */
  id: string;
  /** Target type — typically `page` for browser tabs. */
  type: string;
  /** Current top-level URL. */
  url: string;
  /** Document `<title>` as Chrome reports it. */
  title: string;
  /** Chrome's frontend devtools URL for the target. */
  devtoolsUrl?: string;
}

export interface ReadCdpPageStateOptions {
  /** Chrome HTTP CDP discovery base URL, e.g. `http://127.0.0.1:9222`.
   *  Defaults to the Chromium devtools default. */
  cdpEndpoint?: string;
  /** Optional predicate — only matching targets are returned. */
  filter?: (target: CdpPageTarget) => boolean;
}

/**
 * Enumerate Chrome page targets via the HTTP CDP discovery endpoint
 * (`GET /json`). Used by scenario tests to assert on the URL/title of
 * tabs the agent drove via the `open` shell command, without taking a
 * dependency on Playwright's own browser context (the agent-driven
 * Chrome is typically distinct from the Playwright-launched one).
 *
 * Returns `[]` (NOT throws) on connection failure so a scenario can
 * poll without try/catch noise. The caller decides how long to wait.
 */
export async function readCdpPageState(
  options: ReadCdpPageStateOptions = {}
): Promise<CdpPageTarget[]> {
  const base = options.cdpEndpoint ?? 'http://127.0.0.1:9222';
  let raw: unknown;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/json`);
    if (!res.ok) {
      console.warn(`[readCdpPageState] CDP probe failed: HTTP ${res.status} from ${base}/json`);
      return [];
    }
    raw = await res.json();
  } catch (err) {
    console.warn('[readCdpPageState] CDP probe failed:', err);
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const targets: CdpPageTarget[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry?.['id'] !== 'string') continue;
    const target: CdpPageTarget = {
      id: entry['id'] as string,
      type: typeof entry['type'] === 'string' ? (entry['type'] as string) : '',
      url: typeof entry['url'] === 'string' ? (entry['url'] as string) : '',
      title: typeof entry['title'] === 'string' ? (entry['title'] as string) : '',
      devtoolsUrl:
        typeof entry['devtoolsFrontendUrl'] === 'string'
          ? (entry['devtoolsFrontendUrl'] as string)
          : undefined,
    };
    if (options.filter && !options.filter(target)) continue;
    targets.push(target);
  }
  return targets;
}
