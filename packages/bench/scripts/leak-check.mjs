#!/usr/bin/env node
/**
 * leak-check — fail when a plaintext file in a bench out dir contains task text.
 *
 * Upstream sets (BU Bench) must never be published in plaintext: their traces are written
 * encrypted (`.json.enc`). Everything else in the out dir is uploaded as is, so it must not quote
 * a task: an arm's driver files, an error message, a log line. This runs before every upload.
 * It reports the file and the task id, never the text.
 *
 *   node packages/bench/scripts/leak-check.mjs --out <dir> --set <spec> [--set …] [--canary S]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSet } from './run.mjs';

/** Files that are uploaded as text and so could carry a task's words. */
const TEXT = /\.(json|jsonl|md|txt|log|html|csv|tsv|ya?ml)$/i;
/** Snippets shorter than this match by accident (common phrases). */
export const MIN_NEEDLE = 32;
const WINDOW = 48;

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

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      set: { type: 'string', multiple: true },
      canary: { type: 'string', multiple: true },
    },
  });
  if (!values.out) throw new Error('--out <dir> is required');
  const needles = [];
  for (const spec of values.set ?? []) {
    const set = await (deps.loadSet ?? loadSet)(spec);
    for (const t of set.tasks) needles.push(...needlesFor(t.id, t.task));
  }
  for (const c of values.canary ?? []) needles.push({ id: 'canary', text: collapse(c) });
  const paths = textFiles(values.out);
  const leaks = findLeaks(
    paths.map((p) => ({ path: relative(values.out, p), text: readFileSync(p, 'utf8') })),
    needles
  );
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
