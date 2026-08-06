import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const SOURCE_ROOT = 'packages/webapp/src';
const LAYER_SUPPRESSION = 'biome-ignore lint/plugin/layer-';

function parseReport(report) {
  const parsed = typeof report === 'string' ? JSON.parse(report) : report;
  if (!parsed || !Array.isArray(parsed.diagnostics)) {
    throw new TypeError('Biome JSON report must contain a diagnostics array');
  }
  return parsed;
}

function descriptorByMessage(plugins) {
  const byMessage = new Map();
  for (const plugin of plugins) {
    if (byMessage.has(plugin.message)) {
      throw new TypeError(`generated plugins must have unique messages: ${plugin.message}`);
    }
    byMessage.set(plugin.message, plugin);
  }
  return byMessage;
}

function sourcePath(repoRoot, diagnosticPath) {
  const sourceRoot = resolve(repoRoot, SOURCE_ROOT);
  const absolute = resolve(repoRoot, diagnosticPath);
  if (absolute !== sourceRoot && !absolute.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error(`plugin diagnostic is outside ${SOURCE_ROOT}: ${diagnosticPath}`);
  }
  return absolute;
}

function suppressionReason(ruleId, importSource) {
  if (ruleId === 'layer-cdp' && /(?:\.\.\/)+scoops\//.test(importSource)) {
    return 'migrated known layer debt from issue #1950';
  }
  if (/(?:\.\.\/)+ui\//.test(importSource)) {
    return 'migrated from ui-back-edge-baseline.json';
  }
  return 'migrated existing layer-boundary debt';
}

function diagnosticHits(report, plugins) {
  const byMessage = descriptorByMessage(plugins);
  return parseReport(report).diagnostics.flatMap((diagnostic) => {
    if (diagnostic.category !== 'plugin') return [];
    const plugin = byMessage.get(diagnostic.message);
    if (!plugin) return [];
    const location = diagnostic.location;
    if (!location?.path || !Number.isInteger(location.start?.line)) {
      throw new TypeError(`plugin diagnostic for ${plugin.ruleId} has no source line`);
    }
    return [{ diagnostic, plugin }];
  });
}

export function planLayerSuppressions(repoRoot, report, plugins) {
  const hits = diagnosticHits(report, plugins);
  const zoneHits = hits.filter(({ plugin }) => plugin.kind === 'zone');
  if (zoneHits.length > 0) {
    const locations = zoneHits.map(
      ({ diagnostic }) => `${diagnostic.location.path}:${diagnostic.location.start.line}`
    );
    throw new Error(
      `zero-tolerance zone violation(s); no suppressions written: ${locations.join(', ')}`
    );
  }

  const edits = new Map();
  const counts = {};
  for (const { diagnostic, plugin } of hits) {
    const { path, start, end } = diagnostic.location;
    const absolute = sourcePath(repoRoot, path);
    const entry = edits.get(path) ?? {
      absolute,
      lines: readFileSync(absolute, 'utf8').split('\n'),
      insertions: [],
    };
    const line = entry.lines[start.line - 1];
    if (line === undefined) throw new Error(`diagnostic line is outside ${path}:${start.line}`);
    const importSource = line.slice(start.column - 1, end?.column ? end.column - 1 : undefined);
    const lineIndent = line.match(/^\s*/)?.[0] ?? '';
    const previousIndent = entry.lines[start.line - 2]?.match(/^\s*/)?.[0] ?? '';
    const indent =
      line.trimStart().startsWith('}') && previousIndent.length > lineIndent.length
        ? previousIndent
        : lineIndent;
    const comment = `${indent}// biome-ignore lint/plugin/${plugin.ruleId}: ${suppressionReason(plugin.ruleId, importSource)}`;
    const key = `${start.line}:${plugin.ruleId}`;
    if (entry.insertions.some((item) => item.key === key)) {
      throw new Error(`duplicate plugin diagnostic at ${path}:${start.line} for ${plugin.ruleId}`);
    }
    entry.insertions.push({ comment, key, line: start.line });
    edits.set(path, entry);
    counts[plugin.ruleId] = (counts[plugin.ruleId] ?? 0) + 1;
  }

  const files = [...edits.entries()].map(([path, entry]) => {
    for (const insertion of entry.insertions.sort((a, b) => b.line - a.line)) {
      entry.lines.splice(insertion.line - 1, 0, insertion.comment);
    }
    return { absolute: entry.absolute, content: entry.lines.join('\n'), path };
  });
  return { counts, files, suppressionCount: hits.length };
}

export function writeLayerSuppressions(plan) {
  for (const file of plan.files) writeFileSync(file.absolute, file.content);
}

export function findUnusedLayerSuppressions(repoRoot, report) {
  return parseReport(report).diagnostics.flatMap((diagnostic) => {
    if (diagnostic.category !== 'suppressions/unused') return [];
    const location = diagnostic.location;
    if (!location?.path || !Number.isInteger(location.start?.line)) {
      throw new TypeError('unused suppression diagnostic has no source line');
    }
    const absolute = sourcePath(repoRoot, location.path);
    const line = readFileSync(absolute, 'utf8').split('\n')[location.start.line - 1];
    if (!line?.includes(LAYER_SUPPRESSION)) return [];
    return [{ line: location.start.line, path: location.path }];
  });
}

export function findLayerSuppressionFiles(sourceRoot, pathRoot) {
  if (!existsSync(sourceRoot)) return [];
  const files = [];
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && readFileSync(path, 'utf8').includes(LAYER_SUPPRESSION)) {
        files.push(relative(pathRoot, path).split(sep).join('/'));
      }
    }
  }
  return files.sort();
}
