#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSet } from './run.mjs';

const TEXT = /\.(json|jsonl|md|txt|log|html|csv|tsv|ya?ml)$/i;

export const MIN_NEEDLE = 32;
const WINDOW = 48;

export const collapse = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function needlesFor(id, text) {
  const t = collapse(String(text ?? '').replace(/https?:\/\/\S+/g, ' '));
  if (t.length < MIN_NEEDLE) return [];
  if (t.length <= WINDOW) return [{ id, text: t }];
  const at = [0, Math.floor((t.length - WINDOW) / 2), t.length - WINDOW];
  return [...new Set(at)].map((i) => ({ id, text: t.slice(i, i + WINDOW) }));
}

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

    if (!set.encrypted) continue;
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
