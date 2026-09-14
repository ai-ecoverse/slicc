import type { Page } from '@playwright/test';
import { CDP_PORT, FAKE_LLM_PORT } from './playwright.config.js';

export const FAKE_LLM_BASE_URL = `http://127.0.0.1:${FAKE_LLM_PORT}/v1`;

export async function resetFakeLlm(baseUrl: string = FAKE_LLM_BASE_URL): Promise<void> {
  const origin = baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${origin}/__reset`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`resetFakeLlm: HTTP ${res.status} resetting fake LLM at ${origin}/__reset`);
  }
}

export type RecordedRequest = Array<{ role: string; content?: unknown }>;

export async function readFakeLlmRequests(
  baseUrl: string = FAKE_LLM_BASE_URL
): Promise<RecordedRequest[]> {
  const origin = baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${origin}/__requests`);
  if (!res.ok) {
    throw new Error(`readFakeLlmRequests: HTTP ${res.status} at ${origin}/__requests`);
  }
  const body = (await res.json()) as { requests?: RecordedRequest[] };
  return body.requests ?? [];
}

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

const LOCAL_LLM_PROVIDER_ID = 'local-llm';

const ACCOUNTS_KEY = 'slicc_accounts';
const MODEL_KEY = 'selected-model';

export interface SeedLocalLlmOptions {
  baseUrl?: string;

  modelId: string;

  modelIds?: readonly string[];

  apiKey?: string;
}

export async function seedLocalLlmProvider(
  page: Page,
  options: SeedLocalLlmOptions
): Promise<void> {
  const baseUrl = options.baseUrl ?? FAKE_LLM_BASE_URL;
  const apiKey = options.apiKey ?? 'local';
  const { modelId } = options;
  const deployment = [...(options.modelIds ?? [modelId])].join(',');
  await page.addInitScript(
    (seed: {
      providerId: string;
      apiKey: string;
      baseUrl: string;
      modelId: string;
      deployment: string;
      accountsKey: string;
      modelKey: string;
    }) => {
      try {
        const entry = {
          providerId: seed.providerId,
          apiKey: seed.apiKey,
          baseUrl: seed.baseUrl,
          deployment: seed.deployment,
        };
        localStorage.setItem(seed.accountsKey, JSON.stringify([entry]));
        localStorage.setItem(seed.modelKey, `${seed.providerId}:${seed.modelId}`);
      } catch {}
    },
    {
      providerId: LOCAL_LLM_PROVIDER_ID,
      apiKey,
      baseUrl,
      modelId,
      deployment,
      accountsKey: ACCOUNTS_KEY,
      modelKey: MODEL_KEY,
    }
  );
}

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
  timeoutMs?: number;

  riseTimeoutMs?: number;

  mustObserveTurnRise?: boolean;
}

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
  id: string;

  type: string;

  url: string;

  title: string;

  devtoolsUrl?: string;
}

export interface ReadCdpPageStateOptions {
  cdpEndpoint?: string;

  filter?: (target: CdpPageTarget) => boolean;
}

export async function readCdpPageState(
  options: ReadCdpPageStateOptions = {}
): Promise<CdpPageTarget[]> {
  const base = options.cdpEndpoint ?? `http://127.0.0.1:${CDP_PORT}`;
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

export async function closeCdpPageTargets(options: ReadCdpPageStateOptions = {}): Promise<void> {
  const base = (options.cdpEndpoint ?? `http://127.0.0.1:${CDP_PORT}`).replace(/\/+$/, '');
  const targets = await readCdpPageState(options);
  await Promise.all(
    targets.map(async (target) => {
      const res = await fetch(`${base}/json/close/${encodeURIComponent(target.id)}`);
      if (!res.ok) {
        throw new Error(`Failed to close CDP target ${target.id}: HTTP ${res.status}`);
      }
    })
  );

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readCdpPageState(options)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for CDP targets to close');
}
