import { dirname, join } from 'node:path';

const ANNOTATION_RE = /^::(error|warning|notice)\s+(.*?)::([\s\S]*)$/;

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

export function formatGithubAnnotation(annotation) {
  const props = Object.entries(annotation.fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `::${annotation.level} ${props}::${annotation.message}`;
}

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
