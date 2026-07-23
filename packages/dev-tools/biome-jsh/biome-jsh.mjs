#!/usr/bin/env node
/*
 * biome-jsh — a jsh-aware Biome runner.
 *
 * Biome's CLI ignores `.jsh`/`.bsh` files, and these scripts run as an
 * AsyncFunction body (top-level `await` AND `return` are valid). Renaming a
 * `.jsh` to `.js` and linting it (the naive hack) makes Biome parse the body
 * as a module and emit a bogus "Illegal return statement outside of a
 * function" error. This tool instead wraps each `.jsh`/`.bsh` body in an async
 * function, runs Biome (`--reporter=github`) on the wrapped temp `.js`, then
 * shifts every diagnostic back onto the real file — so top-level await/return
 * never trip a false positive. `.js/.ts/.json/...` pass straight through.
 *
 * Usage:
 *   biome-jsh check  [paths...]        Lint + format-check (github reporter)
 *   biome-jsh format [paths...]        Print formatted output to stdout
 *   biome-jsh format --write [paths...] Format in place
 *
 * The `@biomejs/biome` binary is resolved at runtime from `node_modules/.bin`
 * (walking up from CWD and from this file), or from $BIOME_BIN — it is NOT
 * bundled, so an existing install is reused rather than a fresh one required.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isLintableFile,
  JSH_WRAP_PREFIX_LINE_COUNT,
  shouldWrapForBiome,
  unwrapFormattedJsh,
  wrapJshForBiome,
} from './jsh-biome-source.mjs';
import {
  biomeBinCandidates,
  formatGithubAnnotation,
  makeErrorAnnotation,
  remapGithubOutput,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `biome-jsh - a jsh-aware Biome runner

Usage:
  biome-jsh check  [paths...]          Lint + format-check (--reporter=github)
  biome-jsh format [paths...]          Print formatted output to stdout
  biome-jsh format --write [paths...]  Format files in place

.jsh/.bsh bodies are wrapped in an async function before Biome sees them, so
top-level await/return do not raise a false "return outside of function" error.
Diagnostics are shifted back onto the real file. Other extensions pass through.

Env:
  BIOME_BIN   Path to the @biomejs/biome binary (default: resolved from
              node_modules/.bin, walking up from CWD and this tool).
`;

function resolveBiomeBinary() {
  const fromEnv = process.env.BIOME_BIN;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    fail(`BIOME_BIN is set to '${fromEnv}' but that file does not exist`);
  }
  for (const candidate of biomeBinCandidates([process.cwd(), HERE])) {
    if (existsSync(candidate)) return candidate;
  }
  fail(
    'could not find the @biomejs/biome binary. Install it (npm i @biomejs/biome) ' +
      'or set BIOME_BIN to its path.'
  );
}

function runBiome(bin, args, cwd) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`failed to run biome: ${result.error.message}`);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  };
}

function parseArgs(argv) {
  const parsed = { subcommand: null, paths: [], write: false, help: false, version: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '-v' || arg === '--version') parsed.version = true;
    else if (arg === '--write') parsed.write = true;
    else if (parsed.subcommand === null && (arg === 'check' || arg === 'format'))
      parsed.subcommand = arg;
    else if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    else parsed.paths.push(arg);
  }
  return parsed;
}

function expandPaths(paths) {
  const files = [];
  const missing = [];
  for (const raw of paths) {
    if (!existsSync(raw)) {
      missing.push(raw);
      continue;
    }
    if (statSync(raw).isDirectory()) walkDirectory(raw, files);
    else if (isLintableFile(raw)) files.push(raw);
  }
  return { files, missing };
}

function walkDirectory(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDirectory(full, out);
    else if (isLintableFile(full)) out.push(full);
  }
}

/** Format the wrapped content of a `.jsh`/`.bsh` file back to real-file terms.
 * Biome 2.x `format` (no --write) only prints a diff, so we format the temp in
 * place with `--write` and read it back. Mirrors the webapp WASM path: a
 * re-format round-trip guards the tab de-indent so a lossy unwrap (multi-line
 * template literals whose lines start with a real tab) keeps the source. */
function formatWrapped(bin, source, dir, tempBase, tempPath) {
  const wrapped = wrapJshForBiome(source);
  writeFileSync(tempPath, wrapped);
  runBiome(bin, ['format', '--write', tempBase], dir);
  const formattedWrapped = readFileSync(tempPath, 'utf8');
  // Unchanged (already formatted) or biome aborted on a parse error → no diff.
  if (formattedWrapped === wrapped) return { safe: source, changed: false };
  const candidate = unwrapFormattedJsh(formattedWrapped);
  writeFileSync(tempPath, wrapJshForBiome(candidate));
  runBiome(bin, ['format', '--write', tempBase], dir);
  const reFormatted = readFileSync(tempPath, 'utf8');
  const safe = reFormatted === formattedWrapped ? candidate : source;
  return { safe, changed: safe !== source };
}

function processWrappedCheck(bin, file) {
  const dir = dirname(file);
  const source = readFileSync(file, 'utf8');
  const tempBase = tempName(file);
  const tempPath = join(dir, tempBase);
  const out = { lines: [], errorCount: 0, warningCount: 0 };
  try {
    writeFileSync(tempPath, wrapJshForBiome(source));
    const lint = runBiome(bin, ['lint', '--reporter=github', tempBase], dir);
    const remapped = remapGithubOutput(lint.stdout, file, JSH_WRAP_PREFIX_LINE_COUNT);
    out.lines.push(...remapped.lines);
    out.errorCount += remapped.errorCount;
    out.warningCount += remapped.warningCount;
    // A hard biome failure (e.g. bad config) exits non-zero with no annotations.
    if (lint.status !== 0 && remapped.errorCount === 0 && remapped.warningCount === 0) {
      out.errorCount++;
      out.lines.push(makeStderrLines(lint.stderr));
    }
    const { safe } = formatWrapped(bin, source, dir, tempBase, tempPath);
    if (safe !== source) {
      out.lines.push(
        formatGithubAnnotation(
          makeErrorAnnotation(file, 'File is not formatted (run: biome-jsh format --write)')
        )
      );
      out.errorCount++;
    }
  } finally {
    safeUnlink(tempPath);
  }
  return out;
}

function processWrappedFormat(bin, file, write) {
  const dir = dirname(file);
  const source = readFileSync(file, 'utf8');
  const tempBase = tempName(file);
  const tempPath = join(dir, tempBase);
  try {
    const { safe, changed } = formatWrapped(bin, source, dir, tempBase, tempPath);
    if (write) {
      if (changed) writeFileSync(file, safe);
      return { stdout: '', changed };
    }
    return { stdout: safe, changed };
  } finally {
    safeUnlink(tempPath);
  }
}

function processPlainCheck(bin, file) {
  const dir = dirname(file);
  const result = runBiome(bin, ['check', '--reporter=github', basename(file)], dir);
  const remapped = remapGithubOutput(result.stdout, file, 0);
  if (result.status !== 0 && remapped.errorCount === 0 && remapped.warningCount === 0) {
    remapped.errorCount++;
    remapped.lines.push(makeStderrLines(result.stderr));
  }
  return remapped;
}

function processPlainFormat(bin, file, write) {
  const dir = dirname(file);
  if (write) {
    runBiome(bin, ['format', '--write', basename(file)], dir);
    return { stdout: '' };
  }
  // Biome 2.x `format` (no --write) prints a diff, not the formatted content,
  // so format a same-extension temp copy in place and read it back.
  const source = readFileSync(file, 'utf8');
  const dot = basename(file).lastIndexOf('.');
  const ext = dot >= 0 ? basename(file).slice(dot) : '';
  const tempBase = `${basename(file)}.__biomejsh__.${mkToken()}${ext}`;
  const tempPath = join(dir, tempBase);
  try {
    writeFileSync(tempPath, source);
    runBiome(bin, ['format', '--write', tempBase], dir);
    return { stdout: readFileSync(tempPath, 'utf8') };
  } finally {
    safeUnlink(tempPath);
  }
}

function tempName(file) {
  const token = mkToken();
  return `${basename(file)}.__biomejsh__.${token}.js`;
}

let tokenCounter = 0;
function mkToken() {
  tokenCounter += 1;
  return `${process.pid}-${Date.now()}-${tokenCounter}`;
}

function makeStderrLines(stderr) {
  return stderr.trim() === '' ? 'biome exited non-zero' : stderr.trimEnd();
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function fail(message) {
  process.stderr.write(`biome-jsh: ${message}\n`);
  process.exit(2);
}

function runCheck(bin, files, missing) {
  const outLines = [];
  let errorCount = missing.length;
  let warningCount = 0;
  for (const file of files) {
    const r = shouldWrapForBiome(file)
      ? processWrappedCheck(bin, file)
      : processPlainCheck(bin, file);
    outLines.push(...r.lines);
    errorCount += r.errorCount;
    warningCount += r.warningCount;
  }
  if (outLines.length > 0) process.stdout.write(outLines.join('\n') + '\n');
  process.stderr.write(
    `biome-jsh: ${files.length} file(s), ${errorCount} error(s), ${warningCount} warning(s)\n`
  );
  process.exitCode = errorCount > 0 ? 1 : 0;
}

function runFormat(bin, files, write, hadMissing) {
  const stdoutChunks = [];
  for (const file of files) {
    const r = shouldWrapForBiome(file)
      ? processWrappedFormat(bin, file, write)
      : processPlainFormat(bin, file, write);
    if (!write && r.stdout) stdoutChunks.push(r.stdout);
  }
  if (!write && stdoutChunks.length > 0) process.stdout.write(stdoutChunks.join(''));
  process.exitCode = hadMissing ? 1 : 0;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || (!parsed.subcommand && parsed.paths.length === 0 && !parsed.version)) {
    process.stdout.write(HELP);
    return;
  }
  const bin = resolveBiomeBinary();
  if (parsed.version) {
    const v = runBiome(bin, ['--version'], process.cwd());
    process.stdout.write(v.stdout || v.stderr);
    return;
  }
  if (!parsed.subcommand) fail('missing subcommand (expected check or format)');
  if (parsed.paths.length === 0) fail('no files or directories specified');

  const { files, missing } = expandPaths(parsed.paths);
  for (const m of missing) process.stderr.write(`biome-jsh: ${m}: no such file or directory\n`);

  if (parsed.subcommand === 'check') runCheck(bin, files, missing);
  else runFormat(bin, files, parsed.write, missing.length > 0);
}

main();
