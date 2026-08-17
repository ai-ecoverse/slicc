// Pure parsing + analysis for the Swift/SPM unused-dependency gate.
//
// The Go modules get their unused-dependency coverage from `go mod tidy
// -diff` (see each module's `make tidy-check`) and the TS workspaces from
// knip. Swift Package Manager ships no equivalent — `swift build` links a
// declared dependency whether or not a single source file imports it — so
// this module reconstructs the same signal from the manifest plus the
// `import` graph:
//
//   * a `.package(...)` clause no target consumes  → unused package dependency
//   * a target dependency no source of that target imports → unused target dependency
//   * a module a target imports without declaring   → unlisted dependency
//
// Everything here is string-level on purpose: the gate runs in the Linux
// `lint` CI job, which has no Swift toolchain, so it cannot evaluate
// Package.swift as code.

/** Target-declaring factory methods in PackageDescription. */
const TARGET_FACTORIES = [
  'target',
  'executableTarget',
  'testTarget',
  'macro',
  'plugin',
  'systemLibrary',
  'binaryTarget',
];

/** Factories whose targets carry no Swift sources to scan. */
const SOURCELESS_TARGET_KINDS = new Set(['systemLibrary', 'binaryTarget']);

/** Marker that waives a finding, e.g. `// unused-dep-ok: linked for its resources`. */
const WAIVER_RE = /\/\/\s*unused-dep-ok:\s*(.+?)\s*$/;

const OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/**
 * Replace comment bodies with spaces, preserving every offset and newline so
 * positions in the stripped text map back to the original source.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//' || two === '/*') {
      const end = two === '//' ? endOfLineComment(source, i) : endOfBlockComment(source, i);
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (source[i] === '"') {
      const end = skipString(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

/** Same length and newlines as `text`, every other character a space. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

function endOfLineComment(source, start) {
  const nl = source.indexOf('\n', start);
  return nl === -1 ? source.length : nl;
}

/** End of the (possibly nested) block comment opening at `start`. */
function endOfBlockComment(source, start) {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      depth++;
      i += 2;
      continue;
    }
    if (two === '*/') {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return source.length;
}

/** Index just past the string literal starting at `start` (which is a `"`). */
function skipString(source, start) {
  if (source.startsWith('"""', start)) {
    const end = source.indexOf('"""', start + 3);
    return end === -1 ? source.length : end + 3;
  }
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '"') return i + 1;
    if (source[i] === '\n') return i; // unterminated — bail at the newline
    i++;
  }
  return source.length;
}

/** Index of the bracket matching the one at `open`, or -1. */
export function matchBracket(text, open) {
  const closer = OPEN_TO_CLOSE[text[open]];
  if (!closer) return -1;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (OPEN_TO_CLOSE[ch]) depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Value span of `label:` inside an argument list, searched at nesting depth 0
 * so a nested `name:` inside `.product(...)` never shadows the outer one.
 * Returns `{ start, end }` offsets into `text`, or null.
 */
export function findLabelValue(text, label) {
  const needle = new RegExp(`(^|[\\s(\\[,])${label}\\s*:`, 'g');
  for (const i of topLevelOffsets(text)) {
    needle.lastIndex = i;
    const m = needle.exec(text);
    if (m && m.index === i) return valueSpanAt(text, i + m[0].length);
  }
  return null;
}

/** Offsets of `text` that sit outside every bracket group and string literal. */
function* topLevelOffsets(text) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (depth === 0) yield i;
    if (OPEN_TO_CLOSE[ch]) depth++;
    else if (CLOSERS.has(ch)) depth--;
    i++;
  }
}

/** Span of the value that begins at `from` (skipping leading whitespace). */
function valueSpanAt(text, from) {
  let start = from;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (OPEN_TO_CLOSE[text[start]]) {
    const end = matchBracket(text, start);
    return { start, end: end === -1 ? text.length : end + 1 };
  }
  return { start, end: endOfElement(text, start) };
}

/** End offset of a comma-delimited element starting at `start`. */
function endOfElement(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (OPEN_TO_CLOSE[ch]) depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (ch === ',' && depth === 0) return i;
    i++;
  }
  return text.length;
}

/** Split an array/argument body on top-level commas, keeping offsets. */
export function splitTopLevel(body) {
  const parts = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    const end = endOfElement(body, i);
    const text = body.slice(i, end);
    if (text.trim()) parts.push({ text, start: i });
    i = end + 1;
  }
  return parts;
}

/** Inner body of an array/argument literal (drops the outer brackets). */
function innerBody(text, span) {
  const raw = text.slice(span.start, span.end);
  if (OPEN_TO_CLOSE[raw[0]]) return { body: raw.slice(1, -1), offset: span.start + 1 };
  return { body: raw, offset: span.start };
}

/**
 * Argument list of a `.factory(...)` call expression, so label lookups run at
 * the call's own nesting depth: `{ body, offset }` relative to `text`.
 */
export function unwrapCall(text) {
  const m = /^(\s*)\.\w+\s*\(/.exec(text);
  if (!m) return { body: text, offset: 0 };
  const open = m[0].length - 1;
  const close = matchBracket(text, open);
  if (close === -1) return { body: text, offset: 0 };
  return { body: text.slice(open + 1, close), offset: open + 1 };
}

function stringLiteral(text) {
  const m = /^\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? m[1] : null;
}

function labelString(text, label) {
  const span = findLabelValue(text, label);
  if (!span) return null;
  return stringLiteral(text.slice(span.start, span.end));
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** SPM derives a package's identity from the last URL/path component. */
export function packageIdentity({ url, path, name }) {
  if (name) return name;
  const raw = url ?? path ?? '';
  const last = raw.replace(/\/+$/, '').split('/').pop() ?? '';
  return last.replace(/\.git$/, '');
}

/** Identities are compared case-insensitively, as SPM does. */
function identityKey(identity) {
  return identity.toLowerCase();
}

/**
 * Swift module name for a target/product name: SPM replaces every character
 * that is illegal in an identifier with `_`, so target `slicc-server` is
 * imported as `slicc_server`.
 */
export function moduleName(name) {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Parse a Package.swift manifest into the shape the analysis needs.
 * Returns `{ packageName, dependencies, products, targets }`.
 */
export function parseManifest(source) {
  const stripped = stripComments(source);
  const waivers = collectWaivers(source);
  const pkgCall = /(?:^|\n)\s*let\s+package\s*=\s*Package\s*\(/.exec(stripped);
  if (!pkgCall) throw new Error('no `let package = Package(` clause found');
  const open = stripped.indexOf('(', pkgCall.index + pkgCall[0].indexOf('Package'));
  const close = matchBracket(stripped, open);
  if (close === -1) throw new Error('unbalanced Package( ... ) argument list');
  const argsOffset = open + 1;
  const args = stripped.slice(argsOffset, close);

  const packageName = labelString(args, 'name') ?? '';
  const dependencies = parsePackageDependencies(source, args, argsOffset, waivers);
  const products = parseProducts(args);
  const targets = parseTargets(source, args, argsOffset, waivers);
  return { packageName, dependencies, products, targets };
}

/** Line-indexed `unused-dep-ok:` reasons. */
function collectWaivers(source) {
  const waivers = new Map();
  source.split('\n').forEach((line, idx) => {
    const m = WAIVER_RE.exec(line);
    if (m) waivers.set(idx + 1, m[1]);
  });
  return waivers;
}

/**
 * A waiver applies to the entry's own line or, for a multi-line entry, any
 * line it spans plus the line directly above it.
 */
function waiverFor(waivers, startLine, endLine) {
  for (let line = startLine - 1; line <= endLine; line++) {
    const reason = waivers.get(line);
    if (reason) return reason;
  }
  return null;
}

function parsePackageDependencies(source, args, argsOffset, waivers) {
  const span = findLabelValue(args, 'dependencies');
  if (!span) return [];
  const { body, offset } = innerBody(args, span);
  const out = [];
  for (const part of splitTopLevel(body)) {
    if (!/^\s*\.package\s*\(/.test(part.text)) continue;
    const { body: call } = unwrapCall(part.text);
    const url = labelString(call, 'url');
    const path = labelString(call, 'path');
    const name = labelString(call, 'name');
    const startLine = lineOf(source, argsOffset + offset + part.start);
    const endLine = lineOf(source, argsOffset + offset + part.start + part.text.length);
    out.push({
      identity: packageIdentity({ url, path, name }),
      kind: path ? 'path' : 'url',
      path,
      url,
      line: startLine,
      waiver: waiverFor(waivers, startLine, endLine),
    });
  }
  return out;
}

function parseProducts(args) {
  const span = findLabelValue(args, 'products');
  if (!span) return [];
  const { body } = innerBody(args, span);
  const out = [];
  for (const part of splitTopLevel(body)) {
    const { body: call } = unwrapCall(part.text);
    const name = labelString(call, 'name');
    if (!name) continue;
    out.push({ name, targets: stringArray(call, 'targets') });
  }
  return out;
}

function parseTargets(source, args, argsOffset, waivers) {
  const span = findLabelValue(args, 'targets');
  if (!span) return [];
  const { body, offset } = innerBody(args, span);
  const out = [];
  for (const part of splitTopLevel(body)) {
    const factory = /^\s*\.(\w+)\s*\(/.exec(part.text);
    if (!factory || !TARGET_FACTORIES.includes(factory[1])) continue;
    const kind = factory[1];
    const { body: call, offset: callOffset } = unwrapCall(part.text);
    const name = labelString(call, 'name');
    if (!name) continue;
    const partOffset = argsOffset + offset + part.start;
    out.push({
      name,
      kind,
      isTest: kind === 'testTarget',
      hasSources: !SOURCELESS_TARGET_KINDS.has(kind),
      path: labelString(call, 'path'),
      exclude: stringArray(call, 'exclude'),
      sources: stringArray(call, 'sources'),
      dependencies: parseTargetDependencies(source, call, partOffset + callOffset, waivers),
      line: lineOf(source, partOffset),
    });
  }
  return out;
}

function stringArray(text, label) {
  const span = findLabelValue(text, label);
  if (!span) return [];
  const { body } = innerBody(text, span);
  return splitTopLevel(body)
    .map((p) => stringLiteral(p.text))
    .filter((v) => v !== null);
}

function parseTargetDependencies(source, targetArgs, targetOffset, waivers) {
  const span = findLabelValue(targetArgs, 'dependencies');
  if (!span) return [];
  const { body, offset } = innerBody(targetArgs, span);
  const out = [];
  for (const part of splitTopLevel(body)) {
    const text = part.text.trim();
    const startLine = lineOf(source, targetOffset + offset + part.start);
    const endLine = lineOf(source, targetOffset + offset + part.start + part.text.length);
    const waiver = waiverFor(waivers, startLine, endLine);
    const literal = stringLiteral(text);
    if (literal !== null) {
      out.push({
        module: literal,
        package: null,
        form: 'byName',
        conditional: false,
        line: startLine,
        waiver,
      });
      continue;
    }
    const call = /^\.(\w+)\s*\(/.exec(text);
    if (!call) continue;
    const { body: args } = unwrapCall(part.text);
    const module = labelString(args, 'name');
    if (!module) continue;
    out.push({
      module,
      package: call[1] === 'product' ? labelString(args, 'package') : null,
      form: call[1],
      // `condition:` makes the dependency platform- or config-scoped; the
      // importing sources then sit behind `#if os(...)`, which this gate does
      // not evaluate, so such entries are never flagged as unused.
      conditional: findLabelValue(args, 'condition') !== null,
      line: startLine,
      waiver,
    });
  }
  return out;
}

/**
 * Modules a Swift source imports. Covers plain, attributed
 * (`@_exported`/`@preconcurrency`), submodule (`import A.B` → `A`), and
 * declaration-scoped (`import struct A.B` → `A`) imports, plus
 * `canImport(A)` — a module named in a `#if canImport` check is genuinely
 * consumed by the target even when the import itself is conditional.
 */
export function collectImports(swiftSource) {
  const modules = new Set();
  const text = stripComments(swiftSource);
  const importRe =
    /^[ \t]*(?:@[\w]+(?:\([^)]*\))?[ \t]+)*(?:@testable[ \t]+)?import[ \t]+(?:(?:struct|class|enum|protocol|typealias|func|var|let|actor|macro)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const m of text.matchAll(importRe)) modules.add(m[1]);
  for (const m of text.matchAll(/canImport\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g)) modules.add(m[1]);
  return modules;
}

/**
 * Compare one package's manifest against the modules its targets import.
 *
 * @param {object} input
 * @param {ReturnType<typeof parseManifest>} input.manifest
 * @param {Map<string, Set<string>>} input.importsByTarget imports per target name
 * @param {Map<string, Set<string>>} input.localModulesByPackage modules vended by
 *   each local (`path:`) package dependency, keyed by identity. Used for the
 *   unlisted-dependency check, which stays limited to dependencies whose module
 *   set is knowable from the repo (external packages are not resolved).
 * @returns {{severity: 'error', code: string, message: string, line: number}[]}
 */
export function analyzeManifest({ manifest, importsByTarget, localModulesByPackage = new Map() }) {
  const graph = resolveGraph(manifest, localModulesByPackage);
  const findings = [...unusedPackageDependencies(manifest, graph)];
  for (const target of manifest.targets) {
    if (!target.hasSources) continue;
    const imports = importsByTarget.get(target.name);
    if (!imports) continue;
    findings.push(...unusedTargetDependencies(target, imports, localModulesByPackage));
    findings.push(...unlistedDependencies(target, imports, graph, localModulesByPackage));
  }
  return findings.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
}

/**
 * Which declared packages the targets consume, and where every reachable
 * module comes from. `.product(package:)` states the package outright; a bare
 * `"Name"` entry resolves to a same-package target when one matches, else to
 * the like-named product of a declared package dependency.
 */
function resolveGraph(manifest, localModulesByPackage) {
  const ownTargets = new Set(manifest.targets.map((t) => t.name));
  const moduleOrigin = new Map();
  const referencedPackages = new Set();

  for (const dep of manifest.targets.flatMap((t) => t.dependencies)) {
    if (dep.package) {
      referencedPackages.add(identityKey(dep.package));
      moduleOrigin.set(moduleName(dep.module), `package '${dep.package}'`);
      continue;
    }
    if (ownTargets.has(dep.module)) continue;
    const owner = manifest.dependencies.find(
      (p) =>
        identityKey(p.identity) === identityKey(dep.module) ||
        localModulesByPackage.get(identityKey(p.identity))?.has(dep.module)
    );
    if (!owner) continue;
    referencedPackages.add(identityKey(owner.identity));
    moduleOrigin.set(moduleName(dep.module), `package '${owner.identity}'`);
  }

  for (const dep of manifest.dependencies) {
    for (const m of localModulesByPackage.get(identityKey(dep.identity)) ?? []) {
      if (!moduleOrigin.has(moduleName(m))) {
        moduleOrigin.set(moduleName(m), `package '${dep.identity}'`);
      }
    }
  }
  for (const name of ownTargets) moduleOrigin.set(moduleName(name), 'this package');

  return { moduleOrigin, referencedPackages };
}

function* unusedPackageDependencies(manifest, { referencedPackages }) {
  for (const dep of manifest.dependencies) {
    if (dep.waiver || referencedPackages.has(identityKey(dep.identity))) continue;
    yield {
      severity: 'error',
      code: 'unused-package-dependency',
      line: dep.line,
      message:
        `package dependency '${dep.identity}' is declared but no target ` +
        'consumes a product from it — drop it from `dependencies:`',
    };
  }
}

function* unusedTargetDependencies(target, imports, localModulesByPackage) {
  for (const dep of target.dependencies) {
    if (dep.waiver || dep.conditional) continue;
    // A product may vend several modules; for local packages the manifest
    // tells us which, so importing any of them counts.
    const candidates = [dep.module, ...vendedByDependency(dep, localModulesByPackage)];
    if (candidates.some((m) => imports.has(moduleName(m)))) continue;
    yield {
      severity: 'error',
      code: 'unused-target-dependency',
      line: dep.line,
      message:
        `target '${target.name}' declares '${dep.module}'` +
        (dep.package ? ` (package '${dep.package}')` : '') +
        ' but no source in the target imports it — drop the dependency, or ' +
        'annotate the line with `// unused-dep-ok: <reason>`',
    };
  }
}

function* unlistedDependencies(target, imports, { moduleOrigin }, localModulesByPackage) {
  const declared = new Set(
    target.dependencies
      .flatMap((d) => [d.module, ...vendedByDependency(d, localModulesByPackage)])
      .map(moduleName)
  );
  for (const module of imports) {
    if (declared.has(module) || module === moduleName(target.name)) continue;
    const origin = moduleOrigin.get(module);
    if (!origin) continue;
    yield {
      severity: 'error',
      code: 'unlisted-dependency',
      line: target.line,
      message:
        `target '${target.name}' imports '${module}' from ${origin} without ` +
        'declaring it in `dependencies:` — the build only works via a ' +
        'transitive dependency and breaks when that changes',
    };
  }
}

/** Modules the local package behind a target dependency vends, if known. */
function vendedByDependency(dep, localModulesByPackage) {
  if (!dep.package) return [];
  return [...(localModulesByPackage.get(identityKey(dep.package)) ?? [])];
}

/** Modules a package vends through its library/executable products. */
export function vendedModules(manifest) {
  const modules = new Set();
  for (const product of manifest.products) {
    modules.add(product.name);
    for (const t of product.targets) modules.add(t);
  }
  return modules;
}
