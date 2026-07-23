/**
 * biome-jsh — pure orchestration logic (no I/O, no process spawning).
 *
 * Parses Biome's `--reporter=github` annotation lines, shifts each diagnostic
 * from the wrapped temp file back onto the real `.jsh`/`.bsh` file (line-space
 * shift + path rewrite), and enumerates candidate `@biomejs/biome` binary
 * locations. The I/O — file walking, temp files, spawning Biome, write-back —
 * lives in `biome-jsh.mjs`. Keeping this module side-effect-free lets the
 * span-shift + parsing logic be unit-tested without a Biome binary.
 */

import { dirname, join } from 'node:path';

// Matches a single GitHub Actions workflow-command annotation line, e.g.
//   ::error title=lint/suspicious/noDoubleEquals,file=a.js,line=3,col=8::msg
// Group 1 is the level, group 2 the comma-separated `key=value` property
// block, group 3 the (possibly percent-encoded) message.
const ANNOTATION_RE = /^::(error|warning|notice)\s+(.*?)::([\s\S]*)$/;

/**
 * Parse one `--reporter=github` line into `{ level, fields, message }`, or
 * `null` when the line is not an annotation (Biome also prints a human summary
 * to stdout/stderr that we ignore). `fields` preserves Biome's key order.
 */
export function parseGithubAnnotation(line) {
  const match = ANNOTATION_RE.exec(line);
  if (!match) return null;
  const [, level, propsStr, message] = match;
  const fields = {};
  for (const pair of propsStr.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { level, fields, message };
}

/** Reconstruct a GitHub annotation line from a parsed `{ level, fields, message }`. */
export function formatGithubAnnotation(annotation) {
  const props = Object.entries(annotation.fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `::${annotation.level} ${props}::${annotation.message}`;
}

/**
 * Map a diagnostic computed on the wrapped temp file back onto the real file:
 * rewrite `file=` to `realPath` and subtract `lineDelta` from `line`/`endLine`
 * (clamped ≥ 1). Because the wrapper prefix is one newline-terminated line at
 * column 0, columns are already correct and only the line moves.
 */
export function shiftAnnotationToRealFile(annotation, realPath, lineDelta) {
  const fields = { ...annotation.fields };
  if (fields.file !== undefined) fields.file = realPath;
  for (const key of ['line', 'endLine']) {
    if (fields[key] === undefined) continue;
    const parsed = Number.parseInt(fields[key], 10);
    if (Number.isFinite(parsed)) fields[key] = String(Math.max(1, parsed - lineDelta));
  }
  return { level: annotation.level, fields, message: annotation.message };
}

/**
 * Transform every annotation line of Biome's github-reporter `stdout`: keep
 * non-annotation lines untouched, and rewrite each annotation's `file=` to
 * `realPath` while shifting its `line`/`endLine` back by `lineDelta` (0 for
 * pass-through, non-wrapped files; the prefix line count for wrapped ones).
 * Returns `{ lines, errorCount, warningCount }`.
 */
export function remapGithubOutput(stdout, realPath, lineDelta) {
  const lines = [];
  let errorCount = 0;
  let warningCount = 0;
  for (const raw of splitLines(stdout)) {
    const annotation = parseGithubAnnotation(raw);
    if (!annotation) {
      lines.push(raw);
      continue;
    }
    if (annotation.level === 'error') errorCount++;
    else if (annotation.level === 'warning') warningCount++;
    lines.push(formatGithubAnnotation(shiftAnnotationToRealFile(annotation, realPath, lineDelta)));
  }
  return { lines, errorCount, warningCount };
}

function splitLines(text) {
  if (text === '') return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}

/**
 * Build a GitHub error annotation for a real file at `line` (used to surface
 * "file is not formatted" without any wrapped-source coordinates).
 */
export function makeErrorAnnotation(file, message, line = 1) {
  return {
    level: 'error',
    fields: {
      title: 'format',
      file,
      line: String(line),
      endLine: String(line),
      col: '1',
      endColumn: '1',
    },
    message,
  };
}

/**
 * Candidate `node_modules/.bin/biome` paths, walking up from each start
 * directory to the filesystem root. Deduplicated, order-preserving. The CLI
 * probes these with `existsSync` and uses the first hit.
 */
export function biomeBinCandidates(startDirs) {
  const seen = new Set();
  const candidates = [];
  for (const start of startDirs) {
    let dir = start;
    for (;;) {
      const candidate = join(dir, 'node_modules', '.bin', 'biome');
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return candidates;
}
