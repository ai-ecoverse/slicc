#!/usr/bin/env node

// `// unused-flag-ok: <reason>` (or `// unused-dep-ok:`, same shape as the

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');

export const STALE_DAYS = 90;
export const SINCE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const WAIVER_RE = /\/\/\s*(?:unused-flag-ok|unused-dep-ok):\s*(.+?)\s*$/;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '.git']);
const OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}' };
const OPENERS = new Set(Object.keys(OPEN_TO_CLOSE));
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));

const REGISTRY_REL = 'packages/webapp/src/core/feature-flags.ts';
const WORKER_FLAGS_REL = 'packages/cloudflare-worker/src/flags.ts';
const WRANGLER_REL = 'packages/cloudflare-worker/wrangler.jsonc';

export function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

export function matchBracket(source, openIdx) {
  const start = source[openIdx];
  if (!OPENERS.has(start)) return -1;
  const stack = [OPEN_TO_CLOSE[start]];
  let inStr = null;
  for (let i = openIdx + 1; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (OPENERS.has(c)) stack.push(OPEN_TO_CLOSE[c]);
    else if (CLOSERS.has(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const c = source[i];
    if (c === '"' || c === "'") {
      const end = skipString(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (two === '//') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? source.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (two === '/*') {
      const endTok = source.indexOf('*/', i + 2);
      const end = endTok === -1 ? source.length : endTok + 2;
      out += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return source.length;
}

function quotedStringsIn(block) {
  const ids = [];
  const re = /(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(block))) ids.push({ id: m[2], index: m.index });
  return ids;
}

function typeBlock(source, typeName) {
  const re = new RegExp(`export\\s+type\\s+${typeName}\\s*=`);
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length;
  const semi = source.indexOf(';', start);
  if (semi === -1) return null;
  return { start, end: semi, text: source.slice(start, semi) };
}

export function parseFeatureFlagIdUnion(source) {
  const stripped = stripComments(source);
  const block = typeBlock(stripped, 'FeatureFlagId');
  if (!block) throw new Error('FeatureFlagId union not found');
  return quotedStringsIn(block.text).map(({ id, index }) => ({
    id,
    line: lineAt(source, block.start + index),
  }));
}

export function parseFeatureFlagFloatUnion(source) {
  const stripped = stripComments(source);
  const block = typeBlock(stripped, 'FeatureFlagFloat');
  if (!block) return [];
  return quotedStringsIn(block.text).map(({ id }) => id);
}

function labelString(objectText, label) {
  const re = new RegExp(`(?:^|[,{\\n])\\s*${label}\\s*:\\s*(['"])([^'"]*)\\1`);
  const m = re.exec(objectText);
  return m ? m[2] : undefined;
}

function parseFloatDefaults(objectText) {
  const label = /floatDefaults\s*:/.exec(objectText);
  if (!label) return {};
  const brace = objectText.indexOf('{', label.index);
  if (brace === -1) return {};
  const close = matchBracket(objectText, brace);
  if (close === -1) return {};
  const body = objectText.slice(brace + 1, close);
  const out = {};
  const re = /(?:['"]?([A-Za-z][\w-]*)['"]?)\s*:\s*(['"])([^'"]*)\2/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[3];
  return out;
}

function waiverInRange(source, startIdx, endIdx) {
  const startLine = lineAt(source, startIdx);
  const endLine = lineAt(source, endIdx);
  const lines = source.split('\n');
  for (let n = Math.max(1, startLine - 1); n <= endLine; n++) {
    const m = WAIVER_RE.exec(lines[n - 1] ?? '');
    if (m) return m[1];
  }
  return null;
}

function topLevelGroups(source, openIdx) {
  const end = matchBracket(source, openIdx);
  if (end === -1) return [];
  const groups = [];
  const stack = [];
  let inStr = null;
  let groupStart = null;
  for (let i = openIdx + 1; i < end; i++) {
    const c = source[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (OPENERS.has(c)) {
      if (stack.length === 0) groupStart = i;
      stack.push(OPEN_TO_CLOSE[c]);
    } else if (CLOSERS.has(c)) {
      stack.pop();
      if (stack.length === 0 && groupStart !== null) {
        groups.push({ start: groupStart, end: i, text: source.slice(groupStart, i + 1) });
        groupStart = null;
      }
    }
  }
  return groups;
}

function objectTextOf(groupText) {
  const brace = groupText.indexOf('{');
  if (brace === -1) return groupText;
  const close = matchBracket(groupText, brace);
  if (close === -1) return groupText.slice(brace);
  return groupText.slice(brace, close + 1);
}

export function parseRegistry(source) {
  const stripped = stripComments(source);
  const decl = /const\s+FEATURE_FLAGS\b/.exec(stripped);
  if (!decl) throw new Error('FEATURE_FLAGS registry not found');
  const freeze = stripped.indexOf('Object.freeze([', decl.index);
  if (freeze === -1) throw new Error('FEATURE_FLAGS array not found');
  const open = stripped.indexOf('[', freeze);
  const groups = topLevelGroups(stripped, open);
  return groups.map((group) => {
    const objectText = objectTextOf(group.text);
    const id = labelString(objectText, 'id');
    if (!id) {
      throw new Error(`FEATURE_FLAGS entry at line ${lineAt(source, group.start)} has no id`);
    }
    return {
      id,
      line: lineAt(source, group.start),
      defaultValue: labelString(objectText, 'defaultValue'),
      since: labelString(objectText, 'since'),
      floatDefaults: parseFloatDefaults(objectText),
      waiver: waiverInRange(source, group.start, group.end),
    };
  });
}

export function parseWorkerFallbackKeys(source) {
  const stripped = stripComments(source);
  const decl = /const\s+FALLBACK_BASE_FLAGS\b/.exec(stripped);
  if (!decl) return [];
  const brace = stripped.indexOf('{', decl.index);
  if (brace === -1) return [];
  const close = matchBracket(stripped, brace);
  if (close === -1) return [];
  const body = stripped.slice(brace, close + 1);
  const keys = [];
  const re = /(['"])([^'"]+)\1\s*:/g;
  let m;
  while ((m = re.exec(body))) {
    keys.push({ id: m[2], line: lineAt(source, brace + m.index), path: 'FALLBACK_BASE_FLAGS' });
  }
  return keys;
}

export function stripJsonc(source) {
  return stripComments(source);
}

function walkWranglerFlagConfig(config, envLabel) {
  const keys = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return keys;
  const base = config.base;
  if (base && typeof base === 'object' && !Array.isArray(base)) {
    for (const id of Object.keys(base)) {
      keys.push({ id, path: `${envLabel}.base`, env: envLabel });
    }
  }
  const floats = config.floats;
  if (floats && typeof floats === 'object' && !Array.isArray(floats)) {
    for (const [floatName, overlay] of Object.entries(floats)) {
      if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) continue;
      for (const id of Object.keys(overlay)) {
        keys.push({ id, path: `${envLabel}.floats.${floatName}`, env: envLabel });
      }
    }
  }
  return keys;
}

export function parseWranglerFlagKeys(source) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(source));
  } catch (err) {
    throw new Error(`wrangler.jsonc is not parseable JSONC: ${err.message}`);
  }
  const keys = [];
  keys.push(...walkWranglerFlagConfig(parsed?.vars?.FEATURE_FLAGS, 'production'));
  keys.push(...walkWranglerFlagConfig(parsed?.env?.staging?.vars?.FEATURE_FLAGS, 'staging'));
  return keys;
}

function objectKeys(objectText) {
  const keys = [];
  const re = /(['"])([^'"]+)\1\s*:/g;
  let m;
  while ((m = re.exec(objectText))) keys.push({ id: m[2], index: m.index });
  return keys;
}

export function stringMask(source) {
  const mask = new Uint8Array(source.length);
  let inStr = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      mask[i] = 1;
      if (c === '\\') {
        if (i + 1 < source.length) {
          mask[i + 1] = 1;
          i++;
        }
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
  }
  return mask;
}

function eachOutsideString(source, regex, onMatch) {
  const mask = stringMask(source);
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(source))) {
    if (mask[m.index]) continue;
    onMatch(m);
  }
}

function firstArgObject(source, parenIdx) {
  let i = parenIdx + 1;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== '{') return null;
  const close = matchBracket(source, i);
  if (close === -1) return null;
  return { start: i, end: close, text: source.slice(i, close + 1) };
}

function cherryHitsInFlagsProperty(objectText, absStart, sourceForLines) {
  const hits = [];
  const flagsRe = /\bflags\s*:\s*\{/g;
  let m;
  while ((m = flagsRe.exec(objectText))) {
    const brace = objectText.indexOf('{', m.index);
    const close = matchBracket(objectText, brace);
    if (close === -1) continue;
    for (const key of objectKeys(objectText.slice(brace, close + 1))) {
      hits.push({
        kind: 'cherry-host',
        id: key.id,
        line: lineAt(sourceForLines, absStart + brace + key.index),
      });
    }
  }
  return hits;
}

export function findFlagCallSites(source) {
  const stripped = stripComments(source);
  const hits = [];

  eachOutsideString(
    stripped,
    /\b(isFeatureEnabled|getFeatureValue)\s*\(\s*(['"])([^'"]+)\2/g,
    (m) => {
      hits.push({ kind: m[1], id: m[3], line: lineAt(source, m.index) });
    }
  );

  eachOutsideString(stripped, /\bmountSlicc\s*\(/g, (m) => {
    const obj = firstArgObject(stripped, stripped.indexOf('(', m.index));
    if (!obj) return;
    hits.push(...cherryHitsInFlagsProperty(obj.text, obj.start, source));
  });

  eachOutsideString(stripped, /\bapplyHostFlagOverrides\s*\(/g, (m) => {
    const obj = firstArgObject(stripped, stripped.indexOf('(', m.index));
    if (!obj) return;
    for (const key of objectKeys(obj.text)) {
      hits.push({
        kind: 'cherry-host',
        id: key.id,
        line: lineAt(source, obj.start + key.index),
      });
    }
  });

  return hits;
}

export function parseSince(value) {
  const m = SINCE_RE.exec(value ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function isConstantAcrossFloats(entry, floatIds) {
  if (floatIds.length === 0) {
    return Object.keys(entry.floatDefaults).length === 0;
  }
  const fallback = entry.defaultValue;
  if (fallback === undefined) return false;
  return floatIds.every((floatId) => (entry.floatDefaults[floatId] ?? fallback) === fallback);
}

function lineOfQuotedKey(source, id) {
  const re = new RegExp(`['"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`);
  const idx = source.search(re);
  return idx === -1 ? 1 : lineAt(source, idx);
}

function addUse(uses, id, use) {
  const list = uses.get(id) ?? [];
  list.push(use);
  uses.set(id, list);
}

function codeConsumer(kind) {
  return kind === 'isFeatureEnabled' || kind === 'getFeatureValue' || kind === 'cherry-host';
}

function collectUses(callSites, workerKeys, wranglerKeys) {
  const uses = new Map();
  for (const hit of callSites) addUse(uses, hit.id, hit);
  for (const key of workerKeys) {
    addUse(uses, key.id, { kind: 'worker-fallback', id: key.id, file: key.file, line: key.line });
  }
  for (const key of wranglerKeys) {
    addUse(uses, key.id, {
      kind: 'worker-overlay',
      id: key.id,
      file: key.file,
      line: key.line,
      path: key.path,
    });
  }
  return uses;
}

function unionMismatchFindings(union, registry) {
  const findings = [];
  const unionIds = new Set(union.map((u) => u.id));
  const declared = new Set(registry.map((e) => e.id));
  for (const u of union) {
    if (declared.has(u.id)) continue;
    findings.push({
      severity: 'error',
      code: 'registry-union-mismatch',
      file: REGISTRY_REL,
      line: u.line,
      message: `FeatureFlagId '${u.id}' is not in FEATURE_FLAGS`,
    });
  }
  for (const entry of registry) {
    if (unionIds.has(entry.id)) continue;
    findings.push({
      severity: 'error',
      code: 'registry-union-mismatch',
      file: REGISTRY_REL,
      line: entry.line,
      message: `FEATURE_FLAGS id '${entry.id}' is not in the FeatureFlagId union`,
    });
  }
  return findings;
}

function undeclaredFindings(uses, declared) {
  const findings = [];
  for (const [id, list] of uses) {
    if (declared.has(id)) continue;
    const first = list[0];
    const where = first.path ? ` at ${first.path}` : '';
    findings.push({
      severity: 'error',
      code: 'undeclared-flag',
      file: first.file ?? REGISTRY_REL,
      line: first.line,
      message: `'${id}' is consumed (${first.kind}${where}) but is not in FeatureFlagId / FEATURE_FLAGS`,
    });
  }
  return findings;
}

function sinceFinding(entry, floats, nowUtc, staleDays) {
  if (entry.since === undefined) {
    return {
      severity: 'error',
      code: 'missing-since',
      file: REGISTRY_REL,
      line: entry.line,
      message: `'${entry.id}' is missing required since (ISO date YYYY-MM-DD)`,
    };
  }
  const parsed = parseSince(entry.since);
  if (!parsed) {
    return {
      severity: 'error',
      code: 'invalid-since',
      file: REGISTRY_REL,
      line: entry.line,
      message: `'${entry.id}' has invalid since '${entry.since}' (expected YYYY-MM-DD)`,
    };
  }
  if (!isConstantAcrossFloats(entry, floats) || entry.waiver) return null;
  const age = daysBetween(parsed, nowUtc);
  if (age < staleDays) return null;
  return {
    severity: 'warning',
    code: 'stale-flag',
    file: REGISTRY_REL,
    line: entry.line,
    message:
      `'${entry.id}' has been at a constant default across every float for ${age} days ` +
      `(since ${entry.since}; threshold ${staleDays}). Retire the flag and the losing branch, ` +
      `or annotate the entry with // unused-flag-ok: <reason>.`,
  };
}

function deadFlagFinding(entry, uses) {
  const consumers = (uses.get(entry.id) ?? []).filter((u) => codeConsumer(u.kind));
  if (consumers.length > 0 || entry.waiver) return null;
  return {
    severity: 'error',
    code: 'dead-flag',
    file: REGISTRY_REL,
    line: entry.line,
    message:
      `'${entry.id}' is declared but has no isFeatureEnabled / getFeatureValue / Cherry host consumer. ` +
      `Delete it, or annotate the entry with // unused-flag-ok: <reason>.`,
  };
}

export function analyzeFlags({
  union,
  registry,
  floats,
  callSites,
  workerKeys,
  wranglerKeys,
  now = new Date(),
  staleDays = STALE_DAYS,
}) {
  const declared = new Set(registry.map((e) => e.id));
  const uses = collectUses(callSites, workerKeys, wranglerKeys);
  const nowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const findings = [
    ...unionMismatchFindings(union, registry),
    ...undeclaredFindings(uses, declared),
  ];
  for (const entry of registry) {
    const since = sinceFinding(entry, floats, nowUtc, staleDays);
    if (since) findings.push(since);
    const dead = deadFlagFinding(entry, uses);
    if (dead) findings.push(dead);
  }
  return findings;
}

function collectTsSrc(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTsSrc(abs, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.stories.ts')
    ) {
      out.push(abs);
    }
  }
  return out;
}

function readRel(root, rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

export function checkRepo(root = repoRoot, { now } = {}) {
  const registrySource = readRel(root, REGISTRY_REL);
  const workerSource = readRel(root, WORKER_FLAGS_REL);
  const wranglerSource = readRel(root, WRANGLER_REL);

  const union = parseFeatureFlagIdUnion(registrySource);
  const registry = parseRegistry(registrySource);
  const floats = parseFeatureFlagFloatUnion(registrySource);
  const workerKeys = parseWorkerFallbackKeys(workerSource).map((k) => ({
    ...k,
    file: WORKER_FLAGS_REL,
  }));
  const wranglerKeys = parseWranglerFlagKeys(wranglerSource).map((k) => ({
    ...k,
    file: WRANGLER_REL,
    line: k.line ?? lineOfQuotedKey(wranglerSource, k.id),
  }));

  const packagesDir = resolve(root, 'packages');
  const callSites = [];
  let scanned = 0;
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = resolve(packagesDir, pkg.name, 'src');
    for (const abs of collectTsSrc(srcDir)) {
      scanned++;
      const rel = relative(root, abs).replaceAll('\\', '/');
      for (const hit of findFlagCallSites(readFileSync(abs, 'utf8'))) {
        callSites.push({ ...hit, file: rel });
      }
    }
  }

  const findings = analyzeFlags({
    union,
    registry,
    floats,
    callSites,
    workerKeys,
    wranglerKeys,
    now,
  });
  return { findings, scanned, declared: registry.length };
}

function flagArg(name) {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function main() {
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? repoRoot : resolve(argv[rootFlag + 1] ?? '');
  const nowArg = flagArg('now');
  const now = nowArg ? parseSince(nowArg) : new Date();
  if (nowArg && !now) {
    stderr.write(`::error::invalid --now=${nowArg} (expected YYYY-MM-DD)\n`);
    exit(2);
  }

  let result;
  try {
    result = checkRepo(root, { now });
  } catch (err) {
    stderr.write(`::error::check-dead-flags failed: ${err.message}\n`);
    exit(2);
  }

  const errors = result.findings.filter((f) => f.severity === 'error');
  const warnings = result.findings.filter((f) => f.severity === 'warning');

  for (const f of warnings) {
    stderr.write(`::warning file=${f.file},line=${f.line}::${f.code}: ${f.message}\n`);
  }
  for (const f of errors) {
    stderr.write(`::error file=${f.file},line=${f.line}::${f.code}: ${f.message}\n`);
  }

  if (errors.length > 0) {
    stderr.write(
      `\n${errors.length} dead/undeclared feature-flag issue(s); ${warnings.length} stale warning(s). ` +
        'See docs/feature-flags.md.\n'
    );
    exit(1);
  }

  stdout.write(
    `ok: ${result.declared} feature flags, ${result.scanned} src files scanned` +
      (warnings.length > 0 ? `, ${warnings.length} stale warning(s)` : '') +
      '\n'
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
