/**
 * Vite build plugin: don't let kokoro-js publish its espeak phonemizer before
 * the phonemizer has any languages.
 *
 * `kokoro-js` inlines the `phonemizer` package, whose emscripten build embeds
 * espeak's dictionaries as a gzip blob and registers them ASYNCHRONOUSLY:
 *
 *     (async () => { …DecompressionStream('gzip')… })(),
 *     Module.calledRun ? b() : (Module.preRun ||= []).push(b)
 *
 * Only the `preRun` branch gates startup on that data landing. Take the other
 * branch and the runtime reports ready over an empty filesystem. The espeak
 * instance is published on the same fork:
 *
 *     Module.calledRun ? resolve(new Module.eSpeakNGWorker)
 *                      : Module.onRuntimeInitialized = () => resolve(new …)
 *
 * so `list_voices()` returns `[]`, and because the language registry is built
 * exactly once (`registry = modulePromise.then(build)`) it stays empty for the
 * page's lifetime — every later `phonemize(text, 'en-us')` throws
 * `Invalid language identifier: "en-us". Should be one of: .` No retry at the
 * call site can recover it; the module has to not lie about being ready.
 *
 * Which branch you land on is wasm instantiation racing the decompress, so it
 * is load-sensitive: it needs no code change to start failing, passes on an
 * idle laptop, and fails on a busy CI runner. That is what broke `speech-e2e`
 * for every branch that ran it (SLICC issue: the `say -l en-US` gate).
 *
 * The patch resolves the module promise only once `list_voices()` is actually
 * non-empty (bounded ~10 s, then resolves anyway so a genuinely voiceless
 * build still surfaces the original error rather than hanging). On the happy
 * path — data already registered — the first poll succeeds and nothing changes.
 *
 * Why a build plugin instead of `patch-package`: `kokoro.web.js` ships
 * minified on a single line, so a patch file would carry the whole 1.3 MB line
 * as a diff. This rewrites the EMITTED chunks in `closeBundle`, like
 * `strip-ort-wasm-asset` and `strip-ffmpeg-core-cdn-literal` — and for the
 * same underlying reason: Rolldown does not run JS transform hooks for these
 * dependency modules. Pure helpers are unit-tested in
 * `tests/build/fix-kokoro-espeak-readiness.test.ts`.
 *
 * Upgrade behaviour: if kokoro-js changes this code the anchor stops matching
 * and the build FAILS loudly, the same protection `patch-package`'s version
 * pinning gives. Do not soften that into a warning — a silent no-op here is
 * exactly the failure this plugin exists to prevent.
 *
 * Webapp build only, deliberately: the thin extension bundles no kokoro (speech
 * runs in the hosted leader tab, and `dist/extension/` contains no
 * `eSpeakNGWorker`), so registering this there would only trip the guard above.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * `X.calledRun ? r(new X.eSpeakNGWorker) : X.onRuntimeInitialized = () => r(new X.eSpeakNGWorker)`
 * with whatever names minification chose. Both back-references are required so
 * this cannot match a coincidental pair from another module.
 */
export const ESPEAK_READY_RE =
  /(\w+)\.calledRun\?(\w+)\(new \1\.eSpeakNGWorker\):\1\.onRuntimeInitialized=\(\)=>\2\(new \1\.eSpeakNGWorker\)/g;

/** Marker so a re-run (or a double-registered plugin) is a no-op. */
export const READY_HELPER_NAME = '__sliccEspeakVoicesReady';

/**
 * Poll until espeak reports at least one voice, then resolve.
 *
 * Appended rather than prepended: a function declaration hoists to module
 * scope, so the chunk's own code can call it regardless of where it lands,
 * and appending cannot disturb the ESM import prologue.
 */
const READY_HELPER = `
function ${READY_HELPER_NAME}(resolve, worker) {
  let attempts = 400;
  let seen = 'never polled';
  const usable = () => {
    const voices = worker.list_voices();
    seen = voices.length + ' voice(s), languages: ' +
      JSON.stringify(voices.slice(0, 3).map((v) => (v.languages || []).map((l) => l && l.name)));
    // Mirror what the language registry actually needs. Counting voices is not
    // enough: a half-loaded espeak returns entries whose \`languages\` are empty,
    // which passes a length check and still filters down to an empty registry
    // (kokoro keeps only voices with an \`en\` language).
    return voices.some((v) =>
      (v.languages || []).some((l) => l && String(l.name || '').split('-')[0] === 'en')
    );
  };
  const tick = () => {
    let ready = false;
    try {
      ready = usable();
    } catch (err) {
      seen = 'list_voices threw: ' + ((err && err.message) || err);
      ready = false;
    }
    if (ready) return resolve(worker);
    if (--attempts <= 0) {
      // Resolving anyway keeps kokoro's own error as the failure surface rather
      // than a hung promise — but say WHY, or the next reader is back to
      // guessing from "Should be one of: ." alone.
      console.warn('[espeak] gave up waiting for a usable voice list; last saw ' + seen);
      return resolve(worker);
    }
    setTimeout(tick, 25);
  };
  tick();
}
`;

/** Rewrite one chunk's espeak-ready fork. Idempotent. */
export function fixKokoroEspeakReadiness(code: string): { code: string; changed: boolean } {
  if (code.includes(READY_HELPER_NAME)) return { code, changed: false };
  ESPEAK_READY_RE.lastIndex = 0;
  if (!ESPEAK_READY_RE.test(code)) return { code, changed: false };
  ESPEAK_READY_RE.lastIndex = 0;
  const patched = code.replace(
    ESPEAK_READY_RE,
    (_match, mod: string, resolveFn: string) =>
      `${mod}.calledRun?${READY_HELPER_NAME}(${resolveFn},new ${mod}.eSpeakNGWorker):` +
      `${mod}.onRuntimeInitialized=()=>${READY_HELPER_NAME}(${resolveFn},new ${mod}.eSpeakNGWorker)`
  );
  return { code: `${patched}\n${READY_HELPER}`, changed: true };
}

/** Walk `outDir` and patch every chunk carrying the espeak fork. */
export function fixKokoroEspeakReadinessInDir(outDir: string): { rewritten: string[] } {
  const rewritten: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const source = readFileSync(full, 'utf-8');
      if (!source.includes('eSpeakNGWorker')) continue;
      const { code, changed } = fixKokoroEspeakReadiness(source);
      if (!changed) continue;
      writeFileSync(full, code);
      rewritten.push(relative(outDir, full));
    }
  };
  walk(outDir);
  return { rewritten };
}

export function fixKokoroEspeakReadinessPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'fix-kokoro-espeak-readiness',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const { rewritten } = fixKokoroEspeakReadinessInDir(outDir);
      if (rewritten.length === 0) {
        throw new Error(
          'fix-kokoro-espeak-readiness: no emitted chunk matched the kokoro-js espeak ready fork. ' +
            'kokoro-js probably changed shape — re-check whether the phonemizer still publishes ' +
            'its espeak worker before the gzip dictionary data is registered, then update or ' +
            'delete this plugin. Do NOT ignore this: shipping unpatched reintroduces an empty ' +
            'voice list under load.'
        );
      }
      config.logger.info(
        `[fix-kokoro-espeak-readiness] gated espeak readiness on a non-empty voice list in ${rewritten.length} chunk(s)`
      );
    },
  };
}
