import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isMainModule } from './is-main-module.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const helper = pathToFileURL(join(here, 'is-main-module.mjs')).href;
const scratch = mkdtempSync(join(tmpdir(), 'is-main-module-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('isMainModule', () => {
  const real = join(scratch, 'real');
  const link = join(scratch, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  const script = join(real, 'entry.mjs');
  writeFileSync(
    script,
    `import { isMainModule } from ${JSON.stringify(helper)};\n` +
      `console.log(isMainModule(import.meta.url) ? 'main' : 'imported');\n`
  );

  it('is true when the script runs through a symlinked directory', () => {
    const result = spawnSync(process.execPath, [join(link, 'entry.mjs')], { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe('main');
  });

  it('is true when the script runs by its real path', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe('main');
  });

  it('is false when the module is imported by another script', () => {
    const importer = join(real, 'importer.mjs');
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(script).href)});\n`);
    const result = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe('imported');
  });

  it('is false without an entry script or for a missing path', () => {
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, join(scratch, 'missing.mjs'))).toBe(false);
  });

  it('runs a real gate through a symlinked checkout instead of exiting 0 silently', () => {
    const checkout = join(scratch, 'checkout');
    symlinkSync(repoRoot, checkout);
    const result = spawnSync(
      process.execPath,
      [join(checkout, 'packages/dev-tools/tools/coverage-gate.mjs')],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: coverage-gate.mjs');
  });
});

describe('main-module guards in the repo', () => {
  it('never compare import.meta.url with argv[1] directly', () => {
    const grep = spawnSync(
      'git',
      [
        'grep',
        '-nE',
        String.raw`import\.meta\.url === (pathToFileURL|.file://)|resolve\(process\.argv\[1\]\) ===|fileURLToPath\(import\.meta\.url\) === process\.argv`,
        '--',
        '*.mjs',
        '*.js',
        '*.ts',

        ':!packages/dev-tools/tools/is-main-module.mjs',
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    );

    expect(grep.status, grep.stdout).toBe(1);
  });
});
