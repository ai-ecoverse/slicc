#!/usr/bin/env node
// Fetch SLICC's brain-bootstrap docs in ONE call (F18): /shared/CLAUDE.md plus the
// two load-bearing workspace skills (playwright-cli + mount) plus the skills
// catalog, concatenated into a single sectioned blob the brain reads as ONE tool
// result instead of 3-4 separate curls. You STILL read + adopt the content — this
// only collapses the fetch turns. Reads CUP_BASE. Always exits 0 (a section that
// failed to load is marked "(unavailable)", never silently dropped).
// tva
import { assembleBootstrap, isDirectRun, requireEnv } from './_lib.mjs';

const CORE_DOCS = [
  '/shared/CLAUDE.md',
  '/workspace/skills/playwright-cli/SKILL.md',
  '/workspace/skills/mount/SKILL.md',
];
const SKILLS_DIR = '/workspace/skills';

async function vfsRead(base, path) {
  try {
    const res = await fetch(`${base}/api/vfs/read?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    return (await res.json())?.content ?? '';
  } catch {
    return '';
  }
}

async function vfsList(base, path) {
  try {
    const res = await fetch(`${base}/api/vfs/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    const entries = await res.json();
    if (!Array.isArray(entries)) return '';
    return entries.map((e) => `- ${e.name}${e.type === 'directory' ? '/' : ''}`).join('\n');
  } catch {
    return '';
  }
}

async function main() {
  let base;
  try {
    base = requireEnv('CUP_BASE');
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const [docs, catalog] = await Promise.all([
    Promise.all(CORE_DOCS.map((p) => vfsRead(base, p))),
    vfsList(base, SKILLS_DIR),
  ]);
  const sections = CORE_DOCS.map((title, i) => ({ title, body: docs[i] }));
  sections.push({
    title: `${SKILLS_DIR} (catalog — read any others your task needs)`,
    body: catalog,
  });
  process.stdout.write(`${assembleBootstrap(sections)}\n`);
}

if (isDirectRun(import.meta.url)) main();
