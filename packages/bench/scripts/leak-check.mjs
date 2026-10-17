#!/usr/bin/env node

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadSet } from './run.mjs';

const TEXT = /\.(json|jsonl|md|txt|log|html|csv|tsv|ya?ml)$/i;

export const MIN_NEEDLE = 32;
const WINDOW = 48;

export const SCRUB_PLACEHOLDER = '_…redacted: task quote removed by leak-check…_';

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
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
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
