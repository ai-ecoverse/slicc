import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => readFileSync(resolve(__dirname, '../../src', rel), 'utf8');

function staticImports(source: string): string[] {
  return [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
}

describe('kernel-worker realm boundary: speech', () => {
  it('ensure-speech-assets takes model ids from model-ids, not the engines', () => {
    const imports = staticImports(src('speech/ensure-speech-assets.ts'));

    expect(imports).toContain('./model-ids.js');
    expect(imports).not.toContain('./kokoro-engine.js');
    expect(imports).not.toContain('./whisper-engine.js');
  });

  it('model-ids stays dependency-free', () => {
    expect(staticImports(src('speech/model-ids.ts'))).toEqual([]);
  });

  it('the worker build stubs speak/hear and only those', () => {
    const config = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8');
    expect(config).toContain('speech\\/(speak|hear)');

    const workerPlugins = config.slice(config.indexOf('worker: {'));
    expect(workerPlugins).toContain('stubPageRealmSpeechPlugin()');
    expect(config.slice(0, config.indexOf('worker: {'))).not.toContain(
      'stubPageRealmSpeechPlugin(),'
    );
  });

  it('the stub exports every runtime export the real modules expose', () => {
    const runtimeExports = (source: string): string[] =>
      [...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
    const stub = runtimeExports(src('stubs/speech-page-realm-stub.ts'));

    for (const name of [
      ...runtimeExports(src('speech/speak.ts')),
      ...runtimeExports(src('speech/hear.ts')),
    ]) {
      expect(stub).toContain(name);
    }
  });
});

describe('kernel-worker realm boundary: terminal view', () => {
  it('scoop-context builds the headless shell, not the xterm view layer', () => {
    const imports = staticImports(src('scoops/scoop-context/shell-and-skills.ts'));

    expect(imports).toContain('../../shell/almost-bash-shell-headless.js');
    expect(imports).not.toContain('../../shell/index.js');
  });

  it('the scoop-context facade reaches no shell module at runtime', () => {
    const imports = staticImports(src('scoops/scoop-context.ts'));

    expect(imports.filter((i) => i.includes('/shell/'))).toEqual([]);
  });
});
