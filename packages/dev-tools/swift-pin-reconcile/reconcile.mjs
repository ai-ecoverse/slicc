#!/usr/bin/env node
// Raise stale SPM / xcodegen pins so a split Renovate bump cannot leave
// Package.swift on 150 while project.yml is on 151. `--write` rewrites the
// files; without it, prints the planned edits and exits 0 (nothing to do) or 1
// (drift found). Used by renovate-swift-pin-reconcile.yml.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPinFiles } from './files.mjs';
import { applyMismatches, commitShaFromTagRef, describeMismatch, findMismatches } from './lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function main() {
  const write = process.argv.includes('--write');
  const { contents, projectPins, swiftPins, resolvedPins } = readPinFiles(repoRoot);
  const mismatches = findMismatches({ projectPins, swiftPins, resolvedPins });

  if (mismatches.length === 0) {
    console.log('No SPM/xcodegen pin drift.');
    return;
  }

  for (const m of mismatches) console.log(describeMismatch(m));

  if (!write) {
    console.error(`\n${mismatches.length} dual-pin mismatch(es). Re-run with --write to apply.`);
    process.exitCode = 1;
    return;
  }

  const revisionsByKey = {};
  for (const m of mismatches) {
    if (!m.needsRevision) continue;
    const sha = await fetchTagCommit(m.owner, m.repo, m.targetVersion);
    if (!sha) {
      console.error(`Could not resolve git tag ${m.targetVersion} for ${m.owner}/${m.repo}`);
      process.exitCode = 1;
      return;
    }
    revisionsByKey[m.key] = sha;
    console.log(`tag ${m.owner}/${m.repo} ${m.targetVersion} → ${sha}`);
  }

  const changed = applyMismatches(contents, mismatches, revisionsByKey);
  for (const [path, text] of Object.entries(changed)) {
    writeFileSync(resolve(repoRoot, path), text);
    console.log(`wrote ${path}`);
  }

  if (Object.keys(changed).length === 0) {
    console.error('Mismatches found but no files changed — parser/apply bug.');
    process.exitCode = 1;
  }
}

await main();

/**
 * Lightweight or annotated git tag → the commit SHA Package.resolved stores.
 * Uses GITHUB_TOKEN / GH_TOKEN when set (Actions) and falls back to anonymous.
 */
async function fetchTagCommit(owner, repo, version) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'slicc-swift-pin-reconcile',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const refUrl = `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(version)}`;
  const refRes = await fetch(refUrl, { headers });
  if (!refRes.ok) {
    console.error(`GET ${refUrl} → ${refRes.status} ${await refRes.text()}`);
    return null;
  }
  const refJson = await refRes.json();
  let tagJson = null;
  if (refJson.object?.type === 'tag' && refJson.object.url) {
    const tagRes = await fetch(refJson.object.url, { headers });
    if (!tagRes.ok) {
      console.error(`GET ${refJson.object.url} → ${tagRes.status}`);
      return null;
    }
    tagJson = await tagRes.json();
  }
  return commitShaFromTagRef(refJson, tagJson);
}
