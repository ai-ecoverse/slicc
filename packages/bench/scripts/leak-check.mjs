#!/usr/bin/env node
/**
 * leak-check — fail when a plaintext file in a bench out dir contains task text.
 *
 * Encrypted sets (BU Bench) must never be published in plaintext: their traces are written
 * encrypted (`.json.enc`). Sets from the repo are public and are not checked. Everything else in the out dir is uploaded as is, so it must not quote
 * a task: an arm's driver files, an error message, a log line. This runs before every upload.
 * It reports the file and the task id, never the text.
 *
 * Memory-chain checkpoints (`memory/CLAUDE.md`) can quote a task when the curator extracts
 * notes. Pass `--scrub memory/` so those paths are rewritten (leaking paragraphs dropped)
 * instead of failing the hop and killing the chain. Non-scrub leaks still fail hard.
 *
 *   node packages/bench/scripts/leak-check.mjs --out <dir> --set <spec> [--set …] [--canary S] [--scrub memory/]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSet } from './run.mjs';

/** Files that are uploaded as text and so could carry a task's words. */
const TEXT = /\.(json|jsonl|md|txt|log|html|csv|tsv|ya?ml)$/i;
/** Snippets shorter than this match by accident (common phrases). */
export const MIN_NEEDLE = 32;
const WINDOW = 48;
/** Placeholder left where a leaking memory paragraph was removed. */
export const SCRUB_PLACEHOLDER = '_…redacted: task quote removed by leak-check…_';

export const collapse = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Needles for one task: a few windows of its collapsed text (start, middle, end), so a quote of
 * any part is caught without matching on words every task shares. URLs are not needles.
 */
export function needlesFor(id, text) {
  // URLs are left out: a task's start URL legitimately shows up in records (open tabs).
  const t = collapse(String(text ?? '').replace(/https?:\/\/\S+/g, ' '));
  if (t.length < MIN_NEEDLE) return [];
  if (t.length <= WINDOW) return [{ id, text: t }];
  const at = [0, Math.floor((t.length - WINDOW) / 2), t.length - WINDOW];
  return [...new Set(at)].map((i) => ({ id, text: t.slice(i, i + WINDOW) }));
}

/** Every plaintext file under `dir` (encrypted traces are skipped). */
export function textFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!name.endsWith('.enc') && TEXT.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** `[{ path, id }]` for each file that contains a needle. */
export function findLeaks(files, needles) {
  const leaks = [];
  for (const f of files) {
    const hay = collapse(f.text);
    const hit = needles.find((n) => hay.includes(n.text));
    if (hit) leaks.push({ path: f.path, id: hit.id });
  }
  return leaks;
}

/**
 * Whether a relative out-dir path may be rewritten under `--scrub` prefixes
 * (`memory/`, `memory/**`, or `memory`).
 */
export function matchesScrub(relPath, prefixes) {
  const norm = String(relPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
  for (const raw of prefixes ?? []) {
    let p = String(raw ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '');
    if (!p) continue;
    if (p.endsWith('/**')) p = p.slice(0, -3);
    if (p.endsWith('**')) p = p.slice(0, -2);
    if (!p.endsWith('/')) p = `${p}/`;
    if (norm === p.slice(0, -1) || norm.startsWith(p)) return true;
  }
  return false;
}

/**
 * Drop blank-line-separated blocks whose collapsed text contains a needle.
 * Returns the rewritten text and how many blocks were removed.
 */
export function scrubText(text, needles) {
  if (!needles?.length) return { text: String(text ?? ''), removed: 0 };
  const parts = String(text ?? '').split(/(\n{2,})/);
  let removed = 0;
  const out = [];
  for (const part of parts) {
    if (/^\n+$/.test(part)) {
      out.push(part);
      continue;
    }
    const hay = collapse(part);
    if (hay && needles.some((n) => hay.includes(n.text))) {
      removed += 1;
      out.push(SCRUB_PLACEHOLDER);
    } else {
      out.push(part);
    }
  }
  return { text: out.join(''), removed };
}

/**
 * Rewrite scrubbable leaking files in `outDir`. Returns how many files were touched and how
 * many blocks were removed. Non-scrub leaks are left for the caller to fail on.
 */
export function scrubLeaks(outDir, leaks, needles, scrubPrefixes, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  const read = deps.readFileSync ?? readFileSync;
  const scrubbable = [
    ...new Set(leaks.map((l) => l.path).filter((p) => matchesScrub(p, scrubPrefixes))),
  ];
  let files = 0;
  let removed = 0;
  for (const rel of scrubbable) {
    const abs = join(outDir, ...rel.split(/[/\\]/));
    const before = read(abs, 'utf8');
    const r = scrubText(before, needles);
    let next = r.text;
    let n = r.removed;
    // Spanning matches (needle across blank-line blocks) survive paragraph scrub — wipe to a
    // stub so the chain can still upload. Better an empty checkpoint than a dead lineage.
    if (findLeaks([{ path: rel, text: next }], needles).length) {
      next = `${SCRUB_PLACEHOLDER}\n`;
      n = Math.max(n, 1);
    } else if (n === 0) {
      continue;
    }
    write(abs, next);
    files += 1;
    removed += n;
  }
  return { files, removed };
}

function collectNeedles(values, deps) {
  const needles = [];
  return (async () => {
    for (const spec of values.set ?? []) {
      const set = await (deps.loadSet ?? loadSet)(spec);
      // Only sets published encrypted are secret: a repo task set (smoke.json) is public and its
      // traces are plaintext by design.
      if (!set.encrypted) continue;
      for (const t of set.tasks) needles.push(...needlesFor(t.id, t.task));
    }
    for (const c of values.canary ?? []) needles.push({ id: 'canary', text: collapse(c) });
    return needles;
  })();
}

function scan(outDir, needles) {
  const paths = textFiles(outDir);
  const files = paths.map((p) => ({
    path: relative(outDir, p).split(sep).join('/'),
    text: readFileSync(p, 'utf8'),
  }));
  return { paths, leaks: findLeaks(files, needles) };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      set: { type: 'string', multiple: true },
      canary: { type: 'string', multiple: true },
      scrub: { type: 'string', multiple: true },
    },
  });
  if (!values.out) throw new Error('--out <dir> is required');
  const outDir = values.out;
  const needles = await collectNeedles(values, deps);
  let { paths, leaks } = scan(outDir, needles);
  const scrubPrefixes = values.scrub ?? [];

  if (leaks.length && scrubPrefixes.length) {
    const hard = leaks.filter((l) => !matchesScrub(l.path, scrubPrefixes));
    if (hard.length === 0) {
      const scrubbed = scrubLeaks(outDir, leaks, needles, scrubPrefixes, deps);
      console.error(
        `leak-check: scrubbed ${scrubbed.removed} block(s) in ${scrubbed.files} file(s) under ${scrubPrefixes.join(',')}`
      );
      ({ paths, leaks } = scan(outDir, needles));
    }
  }

  for (const l of leaks) console.error(`leak-check: ${l.path} quotes task ${l.id}`);
  console.error(
    `leak-check: ${paths.length} plaintext files, ${needles.length} needles, ${leaks.length} leak(s)`
  );
  return leaks.length ? 1 : 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
/* v8 ignore next 7 */
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`leak-check: ${err.message}`);
      process.exit(2);
    }
  );
}
