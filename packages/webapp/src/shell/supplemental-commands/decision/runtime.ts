/**
 * Lazy loaders for `@ai-ecoverse/kev.js` and `@ai-ecoverse/cua-s1.js`.
 *
 * Imported only when `kev ask` or `cua-s1 plan` actually runs, so the worker
 * first-load graph stays free of the model runtimes and of onnxruntime-web's
 * second copy. Weights stay on Hugging Face (or a `--from` preview URL).
 * The wasm runtime is the copy speech already stages with `ipk add`.
 */

import { createLogger } from '../../../base/logger.js';
import { toPreviewUrl } from '../../../base/preview-url.js';
import type { JsonValue, KevAnswer, KevQuestion } from './kev-questions.js';
import type { PlanDecision, PlanEntity, PrintedPlan } from './plan-commands.js';
import type { FormElement } from './snapshot-elements.js';

const log = createLogger('decision');

const ORT_DIST_VFS_PATH = '/workspace/node_modules/onnxruntime-web/dist/';

export const KEV_MODEL_URLS = {
  '0.8b': 'https://huggingface.co/ai-ecoverse/kev.js/resolve/main/kev-0.8b',
  '4b': 'https://huggingface.co/ai-ecoverse/kev.js/resolve/main/kev-4b',
  '9b': 'https://huggingface.co/ai-ecoverse/kev.js/resolve/main/kev-9b',
} as const;

export type KevModelName = keyof typeof KEV_MODEL_URLS;

export const CUA_S1_URL = 'https://huggingface.co/ai-ecoverse/cua-s1.js/resolve/main/cua-s1-forms';

const INSTALL_HINT =
  'onnxruntime-web is not staged. Run `ipk add onnxruntime-web` (the same package `say` and `hear` use), then retry.';

export interface KevAskInput {
  state: JsonValue;
  questions: Record<string, KevQuestion>;
  model: KevModelName;
  from: string | null;
  dateFacts: boolean;
}

export interface KevAskOutput {
  model: string;
  answers: Record<string, KevAnswer>;
  latency_ms: number;
}

export interface KevRuntime {
  ask(input: KevAskInput): Promise<KevAskOutput>;
}

export interface CuaPlanInput {
  title: string;
  elements: FormElement[];
  document: string;
  minConfidence: number;
  allowSubmit: boolean;
  from: string | null;
}

export interface CuaRuntime {
  plan(input: CuaPlanInput): Promise<PrintedPlan>;
}

interface OrtEnv {
  env?: { wasm?: { wasmPaths?: string; numThreads?: number } };
  InferenceSession: { create(model: Uint8Array | string, options?: object): Promise<unknown> };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
}

interface LoadedKev {
  systemOne(
    input: unknown,
    opts?: { dateFacts?: boolean }
  ): Promise<{ model: string; answers: Record<string, KevAnswer>; latency_ms: number }>;
}

interface KevModule {
  loadKev(
    url: string,
    options: {
      ort: OrtEnv;
      variant?: string;
      executionProviders?: string[];
      dateFacts?: boolean;
    }
  ): Promise<LoadedKev>;
}

interface CuaModule {
  extractEntities(text: string): PlanEntity[];
  loadCuaS1(
    url: string,
    options: { ort: OrtEnv }
  ): Promise<{
    plan(
      title: string,
      elements: FormElement[],
      entities: PlanEntity[],
      options?: { minConfidence?: number; allowSubmit?: boolean }
    ): Promise<{
      decisions: RawDecision[];
      actions: RawDecision[];
    }>;
  }>;
}

interface RawDecision {
  element: { token?: string; role: string; label: string };
  action: PlanDecision['action'];
  probability: number;
  entityIndex: number | null;
}

const kevCache = new Map<string, Promise<LoadedKev>>();
const cuaCache = new Map<string, ReturnType<CuaModule['loadCuaS1']>>();

function modelBase(explicit: string | null, fallback: string): string {
  if (!explicit) return fallback;
  if (/^https?:\/\//i.test(explicit)) return explicit;
  const path = explicit.startsWith('/') ? explicit : `/${explicit}`;
  return toPreviewUrl(path.replace(/\/?$/, '/'));
}

function configureOrt(ort: OrtEnv): void {
  const wasm = ort.env?.wasm;
  if (!wasm) return;
  if (!wasm.wasmPaths) wasm.wasmPaths = toPreviewUrl(ORT_DIST_VFS_PATH);
  if (typeof crossOriginIsolated === 'boolean' && !crossOriginIsolated) wasm.numThreads = 1;
}

/**
 * The speech stack already ships one onnxruntime-web. Importing the package
 * here would add a second wasm build and a WebGPU build to dist/ui (the
 * bundle-size gate counts every JS file, lazy chunks included). The staged
 * package's own bundles are what `ipk add` puts on the preview path.
 */
const ORT_BUNDLE: Record<'wasm' | 'webgpu', string> = {
  wasm: 'ort.wasm.bundle.min.mjs',
  webgpu: 'ort.webgpu.bundle.min.mjs',
};

async function loadOrt(entry: 'wasm' | 'webgpu'): Promise<OrtEnv> {
  const url = toPreviewUrl(`${ORT_DIST_VFS_PATH}${ORT_BUNDLE[entry]}`);
  try {
    // Vite must not bundle this. The file exists only after `ipk add`.
    const ort = (await import(/* @vite-ignore */ url)) as OrtEnv;
    configureOrt(ort);
    return ort;
  } catch (err) {
    throw new Error(explainDecisionError(err));
  }
}

function cacheKey(base: string, extra: string): string {
  return `${extra}\n${base}`;
}

/** The wasm files live in the ipk tree. A fetch of that path means they are not staged yet. */
export function explainDecisionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes(INSTALL_HINT) ||
    message.includes('onnxruntime-web') ||
    message.includes('ort-wasm')
  ) {
    return message.includes(INSTALL_HINT) ? message : `${INSTALL_HINT}\n${message}`;
  }
  return message;
}

export function createDefaultKevRuntime(): KevRuntime {
  return {
    async ask(input) {
      const base = modelBase(input.from, KEV_MODEL_URLS[input.model]);
      const key = cacheKey(base, input.model);
      let pending = kevCache.get(key);
      if (!pending) {
        pending = (async () => {
          log.info('loading kev', { model: input.model, base });
          const ort = await loadOrt('webgpu');
          const kev = (await import('@ai-ecoverse/kev.js')) as KevModule;
          return kev.loadKev(base, {
            ort,
            variant: 'q8f32',
            executionProviders: ['webgpu', 'wasm'],
            dateFacts: input.dateFacts,
          });
        })();
        kevCache.set(key, pending);
      }
      try {
        const model = await pending;
        const response = await model.systemOne(
          { state: input.state, questions: input.questions },
          { dateFacts: input.dateFacts }
        );
        return {
          model: response.model,
          answers: response.answers,
          latency_ms: response.latency_ms,
        };
      } catch (err) {
        kevCache.delete(key);
        throw new Error(explainDecisionError(err));
      }
    },
  };
}

function toPrinted(raw: RawDecision): PlanDecision {
  return {
    token: raw.element.token ?? '',
    role: raw.element.role,
    label: raw.element.label,
    action: raw.action,
    probability: raw.probability,
    entityIndex: raw.entityIndex,
  };
}

export function createDefaultCuaRuntime(): CuaRuntime {
  return {
    async plan(input) {
      const base = modelBase(input.from, CUA_S1_URL);
      let pending = cuaCache.get(base);
      if (!pending) {
        pending = (async () => {
          log.info('loading cua-s1', { base });
          const ort = await loadOrt('wasm');
          const cua = (await import('@ai-ecoverse/cua-s1.js')) as CuaModule;
          return cua.loadCuaS1(base, { ort });
        })();
        cuaCache.set(base, pending);
      }
      try {
        const model = await pending;
        const cua = (await import('@ai-ecoverse/cua-s1.js')) as CuaModule;
        const entities = cua.extractEntities(input.document);
        const result = await model.plan(input.title, input.elements, entities, {
          minConfidence: input.minConfidence,
          allowSubmit: input.allowSubmit,
        });
        return {
          title: input.title,
          minConfidence: input.minConfidence,
          allowSubmit: input.allowSubmit,
          entities,
          decisions: result.decisions.map(toPrinted),
          actions: result.actions.map(toPrinted),
        };
      } catch (err) {
        cuaCache.delete(base);
        throw new Error(explainDecisionError(err));
      }
    },
  };
}
