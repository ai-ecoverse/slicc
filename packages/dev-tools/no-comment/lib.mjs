import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findComments,
  isDeletedPath,
  isProductMarkdown,
  languageForPath,
  stripSource,
} from './comments.mjs';
import { isNoCommentTree, NO_COMMENT_MARKER } from './marker.mjs';

export { isNoCommentTree, NO_COMMENT_MARKER };

export const STUB_README = `# SLICC

Comment-free mirror of \`main\` for agent-coding benchmarks.
Source comments, JSDoc, CLAUDE.md, AGENTS.md, docs/*.md, and developer skills are stripped.
Do not add them back — \`npm run lint:no-comments\` fails if you do.
`;

export function gitLsFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

export function applyStrip(root, files = gitLsFiles(root)) {
  const stats = { stripped: 0, deleted: 0, unchanged: 0, skipped: 0 };
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      stats.skipped++;
      continue;
    }
    if (isDeletedPath(rel)) {
      unlinkSync(abs);
      stats.deleted++;
      continue;
    }
    const lang = languageForPath(rel);
    if (!lang) {
      stats.skipped++;
      continue;
    }
    if (lstatSync(abs).isSymbolicLink()) {
      stats.skipped++;
      continue;
    }
    const before = readFileSync(abs, 'utf8');
    const after = stripSource(before, lang, rel);
    if (after !== before) {
      writeFileSync(abs, after);
      stats.stripped++;
    } else {
      stats.unchanged++;
    }
  }
  writeFileSync(join(root, NO_COMMENT_MARKER), '');
  writeFileSync(join(root, 'README.md'), STUB_README);
  return stats;
}

export function checkTree(root, { requireMarker = true, files } = {}) {
  if (requireMarker && !isNoCommentTree(root)) {
    return { inactive: true, hits: [], forbidden: [] };
  }
  const list = files ?? gitLsFiles(root);
  const hits = [];
  const forbidden = [];
  for (const rel of list) {
    if (isDeletedPath(rel)) {
      forbidden.push(rel);
      continue;
    }
    const abs = join(root, rel);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
    const lang = languageForPath(rel);
    if (!lang) continue;
    const source = readFileSync(abs, 'utf8');
    for (const hit of findComments(source, lang, rel)) {
      hits.push({ file: rel, ...hit });
    }
  }
  return { inactive: false, hits, forbidden };
}

export { isDeletedPath, isProductMarkdown, languageForPath };
