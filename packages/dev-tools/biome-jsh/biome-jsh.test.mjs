import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { biomeBinCandidates, parseGithubAnnotation } from './lib.mjs';

// Resolve the already-installed @biomejs/biome binary (walking up from the
// repo). The integration tests need a real binary; skip cleanly without one.
const BIOME_BIN = biomeBinCandidates([process.cwd()]).find((p) => existsSync(p));
const CLI = fileURLToPath(new URL('./biome-jsh.mjs', import.meta.url));

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BIOME_BIN },
  });
}

/** Run the installed Biome directly (the naive rename path) for comparison. */
function runBiomeRaw(cwd, args) {
  return spawnSync(BIOME_BIN, args, { cwd, encoding: 'utf8' });
}

describe.skipIf(!BIOME_BIN)('biome-jsh CLI (integration)', () => {
  let dir;
  beforeEach(() => {
    // Fixtures live outside the repo so Biome resolves its DEFAULT config
    // (the repo's own biome.json is version-specific), keeping tests hermetic.
    dir = mkdtempSync(join(tmpdir(), 'biome-jsh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lints a .jsh with top-level await AND return without a false parse error', () => {
    // Clean, already-formatted body that is only valid as an AsyncFunction body.
    const body = 'const value = await Promise.resolve(1);\nreturn value;\n';
    writeFileSync(join(dir, 'tool.jsh'), body);

    const result = runCli(dir, ['check', 'tool.jsh']);
    const combined = result.stdout + result.stderr;

    // The whole point: NO bogus "Illegal return statement / await outside" error.
    expect(combined).not.toMatch(/Illegal return statement/i);
    expect(combined).not.toMatch(/outside of (?:a )?function/i);
    expect(combined).not.toMatch(/return.*outside/i);
    expect(result.status).toBe(0);
  });

  it('the naive rename (no async wrapper) DOES emit the false parse error', () => {
    // Same body written as a plain module — proves the wrapper is what fixes it.
    const body = 'const value = await Promise.resolve(1);\nreturn value;\n';
    writeFileSync(join(dir, 'naive.js'), body);

    const raw = runBiomeRaw(dir, ['lint', '--reporter=github', 'naive.js']);
    expect(raw.stdout + raw.stderr).toMatch(/Illegal return statement outside of a function/i);
  });

  it('maps a real lint error back to the correct real-file line/column', () => {
    // `==` sits on line 2, column 7 of the REAL file; wrapping shifts it to
    // line 3, and the CLI must shift it back to line 2 and rewrite the path.
    const body = 'const x = 1;\nif (x == 2) {\n\tawait Promise.resolve();\n}\nreturn x;\n';
    writeFileSync(join(dir, 'lint.jsh'), body);

    const result = runCli(dir, ['check', 'lint.jsh']);
    const annotation = result.stdout
      .split('\n')
      .map(parseGithubAnnotation)
      .find((a) => a?.fields.title.includes('noDoubleEquals'));

    expect(annotation).toBeTruthy();
    expect(annotation.fields.file).toBe('lint.jsh'); // real path, not the temp .js
    expect(annotation.fields.line).toBe('2');
    expect(annotation.fields.endLine).toBe('2');
    expect(annotation.fields.col).toBe('7');
    expect(result.status).toBe(1);
    // No temp artifacts left behind.
    expect(readFileSync(join(dir, 'lint.jsh'), 'utf8')).toBe(body);
  });

  it('flags an unformatted .jsh under check and fixes it under format --write', () => {
    const messy = 'const x=1\nawait Promise.resolve()\nif(x){return x}\n';
    writeFileSync(join(dir, 'messy.jsh'), messy);

    const check = runCli(dir, ['check', 'messy.jsh']);
    expect(check.stdout).toMatch(/not formatted/i);
    expect(check.status).toBe(1);

    const write = runCli(dir, ['format', '--write', 'messy.jsh']);
    expect(write.status).toBe(0);

    // Written back at column 0 (no wrapper indentation leaks), nested tab kept.
    const formatted = readFileSync(join(dir, 'messy.jsh'), 'utf8');
    expect(formatted).toBe('const x = 1;\nawait Promise.resolve();\nif (x) {\n\treturn x;\n}\n');

    // Re-checking the formatted file no longer reports a format error.
    const recheck = runCli(dir, ['check', 'messy.jsh']);
    expect(recheck.stdout).not.toMatch(/not formatted/i);
    expect(recheck.status).toBe(0);
  });

  it('passes non-jsh files straight through (a clean .ts file has no diagnostics)', () => {
    writeFileSync(join(dir, 'ok.ts'), 'export const answer = 42;\n');
    const result = runCli(dir, ['check', 'ok.ts']);
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('format on an unformattable .jsh surfaces the failure and exits non-zero', () => {
    // A genuine syntax error the async wrapper cannot rescue: Biome cannot
    // format it, so `format --write` must NOT report success silently.
    const broken = 'const x = ;\nreturn x;\n';
    writeFileSync(join(dir, 'broken.jsh'), broken);

    const write = runCli(dir, ['format', '--write', 'broken.jsh']);
    expect(write.status).not.toBe(0);
    // The invalid source is left unchanged, not silently "formatted".
    expect(readFileSync(join(dir, 'broken.jsh'), 'utf8')).toBe(broken);
  });

  it('lint checks lint rules but skips formatting (unlike check)', () => {
    // Unformatted but lint-clean: `check` flags "not formatted"; `lint` doesn't.
    const messy = 'const x=1\nawait Promise.resolve()\nif(x){return x}\n';
    writeFileSync(join(dir, 'messy.jsh'), messy);

    const lint = runCli(dir, ['lint', 'messy.jsh']);
    expect(lint.stdout).not.toMatch(/not formatted/i);
    expect(lint.status).toBe(0);

    const check = runCli(dir, ['check', 'messy.jsh']);
    expect(check.stdout).toMatch(/not formatted/i);
    expect(check.status).toBe(1);
  });

  it('lint still catches a real lint error, mapped to the real line', () => {
    const body = 'const x = 1;\nif (x == 2) {\n\tawait Promise.resolve();\n}\nreturn x;\n';
    writeFileSync(join(dir, 'lint.jsh'), body);

    const result = runCli(dir, ['lint', 'lint.jsh']);
    const annotation = result.stdout
      .split('\n')
      .map(parseGithubAnnotation)
      .find((a) => a?.fields.title.includes('noDoubleEquals'));
    expect(annotation).toBeTruthy();
    expect(annotation.fields.line).toBe('2');
    expect(result.status).toBe(1);
  });
});
