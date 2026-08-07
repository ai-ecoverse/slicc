import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fixKokoroEspeakReadiness,
  fixKokoroEspeakReadinessInDir,
  READY_HELPER_NAME,
} from '../../vite-plugins/fix-kokoro-espeak-readiness.js';

/** The shape kokoro-js emits, minified, with the names rolldown happened to pick. */
const EMITTED =
  'r}};var Tt=new Promise((e=>{o.calledRun?e(new o.eSpeakNGWorker):' +
  'o.onRuntimeInitialized=()=>e(new o.eSpeakNGWorker)})),Et=[`en`],Dt=Tt.then((e=>{let t=e.list_voices()';

describe('fixKokoroEspeakReadiness', () => {
  it('routes both branches through the readiness gate', () => {
    const { code, changed } = fixKokoroEspeakReadiness(EMITTED);
    expect(changed).toBe(true);
    // The bare `resolve(new …eSpeakNGWorker)` is what published a module whose
    // espeak filesystem was still empty; neither branch may keep it.
    expect(code).not.toMatch(/calledRun\?e\(new o\.eSpeakNGWorker\)/);
    expect(code).not.toMatch(/onRuntimeInitialized=\(\)=>e\(new o\.eSpeakNGWorker\)/);
    expect(code).toContain(`${READY_HELPER_NAME}(e,new o.eSpeakNGWorker)`);
    expect(code).toContain(`function ${READY_HELPER_NAME}(`);
  });

  it('waits on a non-empty voice list, then gives up rather than hanging', () => {
    const { code } = fixKokoroEspeakReadiness(EMITTED);
    expect(code).toContain('list_voices().length > 0');
    // A genuinely voiceless build must still surface kokoro's own error
    // instead of a promise that never settles.
    expect(code).toMatch(/--attempts <= 0\) return resolve\(worker\)/);
  });

  it('is idempotent — a second pass leaves the chunk alone', () => {
    const once = fixKokoroEspeakReadiness(EMITTED);
    const twice = fixKokoroEspeakReadiness(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it('leaves unrelated code untouched', () => {
    const other = 'const a=1;foo.calledRun?bar():baz();';
    expect(fixKokoroEspeakReadiness(other)).toEqual({ code: other, changed: false });
  });

  it('rewrites every chunk in the output dir that carries the fork', () => {
    // The webapp build emits the kokoro bundle more than once (page + worker
    // graphs), and missing one is the same bug in half the app.
    const dir = mkdtempSync(join(tmpdir(), 'kokoro-readiness-'));
    writeFileSync(join(dir, 'kokoro-AAAA.js'), EMITTED);
    writeFileSync(join(dir, 'kokoro-BBBB.js'), EMITTED);
    writeFileSync(join(dir, 'unrelated.js'), 'export const x = 1;');

    const { rewritten } = fixKokoroEspeakReadinessInDir(dir);

    expect(rewritten.sort()).toEqual(['kokoro-AAAA.js', 'kokoro-BBBB.js']);
    expect(readFileSync(join(dir, 'kokoro-AAAA.js'), 'utf-8')).toContain(READY_HELPER_NAME);
    expect(readFileSync(join(dir, 'unrelated.js'), 'utf-8')).toBe('export const x = 1;');
  });
});
