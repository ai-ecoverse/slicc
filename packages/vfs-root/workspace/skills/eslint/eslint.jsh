// eslint — lint JavaScript/TypeScript in the VFS with the ipk-installed ESLint.
//
// A thin wrapper over `eslint/universal`'s `Linter`, not the `eslint` CLI: the
// full `eslint` entry pulls in `node:worker_threads` for its multithread lint
// path, which the browser realm does not serve. `eslint/universal` is ESLint's
// own dependency-light entry and is the supported way to lint outside Node.
//
// Everything the CLI does around `Linter` — config discovery, target
// expansion, global ignores, fix write-back, formatters, exit codes — lives
// here.
//
// The linting itself runs in a generated helper script, because a realm's
// `require()` only resolves specifiers the host extracted from the entry
// SOURCE: a `require(configPath)` computed at runtime has no graph edge. The
// helper is written with the discovered config path as a literal, so the host
// resolves and transpiles the config (ESM included) before the helper runs.
//
// Usage:
//   eslint [options] [files|dirs...]
//   echo "code" | eslint --stdin --stdin-filename <path>
//
// Requires: ipk add -g eslint @eslint/js esbuild-wasm

const { exec } = require('sliccy:exec');
const fs = require('fs');

const INSTALL_HINT = 'ipk add -g eslint @eslint/js esbuild-wasm';

const CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
];

const DEFAULT_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.jsh',
  '.bsh',
];

// `.jsh`/`.bsh` run as an AsyncFunction body, so top-level `await` AND
// top-level `return` are valid. Espree parses a bare body as a module and
// reports a fatal "'return' outside of function", so the body is wrapped
// before ESLint sees it. The prefix is exactly ONE line ending in a newline
// and adds no indentation, so a message's column is already correct and only
// its line needs shifting by 1. Follows `jsh-biome-source.ts`.
//
// The function is ANONYMOUS, unlike the biome shim's: a linter reports on the
// scaffold, and a named declaration is a real unused binding, so `no-unused-vars`
// (in `@eslint/js`'s `recommended`) flagged `'__slicc' is defined but never
// used` against line 1 of an otherwise-clean script. No wrapper is entirely
// invisible to every rule, so `isWrapperOnly` below also drops findings that
// live only in the scaffold.
const WRAP_PREFIX = '(async function () {\n';
const WRAP_SUFFIX = '\n})';

const HELP = `eslint - lint JavaScript/TypeScript in the VFS via ipk-installed ESLint

Usage:
  eslint [options] [files|dirs...]
  echo "code" | eslint --stdin --stdin-filename <path>

Options:
  -c, --config <file>       Use this flat config instead of discovery
  --no-config-lookup        Do not search for a config file
  --rule <json>             Inline rules, e.g. --rule '{"semi":"error"}'
  --fix                     Apply fixes to files
  --fix-dry-run             Report what --fix would produce; write nothing
  -f, --format <name>       stylish (default), json, or compact
  --ext <.a,.b>             Extensions to collect when walking a directory
  --max-warnings <n>        Exit 1 when warnings exceed n (-1 disables)
  --quiet                   Report errors only, and ignore --max-warnings
  --stdin                   Lint stdin
  --stdin-filename <path>   Virtual path for stdin (selects the config entry)
  -h, --help                Show this help
  -v, --version             Show the installed eslint version

Configuration:
  Flat config only. Without --config, discovery starts at the first target's
  directory (the cwd for stdin) and walks toward /, taking the first
  ${CONFIG_NAMES.join(', ')}.
  A .ts config needs a loader ESLint resolves itself and is not supported here.

  Top-level ignores-only config entries are applied by this wrapper, because
  Linter.verify does not honor global ignores. node_modules and .git are always
  skipped when walking a directory.

Exit codes:
  0  No errors (and warnings within --max-warnings)
  1  Lint errors, or warnings over --max-warnings
  2  Usage error, missing config, missing packages, or a runtime failure

Install:
  ${INSTALL_HINT}
`;

function fail(message, code) {
  console.error(`eslint: ${message}`);
  process.exit(code === undefined ? 2 : code);
}

/* ------------------------------- arg parsing ------------------------------ */

function valueOf(args, i, flag) {
  const v = args[i + 1];
  if (typeof v !== 'string' || (v.startsWith('-') && v !== '-')) {
    throw new Error(`${flag} requires a value`);
  }
  return v;
}

function parseArgs(args) {
  const out = {
    paths: [],
    config: null,
    configLookup: true,
    rules: null,
    fix: false,
    fixDryRun: false,
    format: 'stylish',
    extensions: DEFAULT_EXTENSIONS,
    maxWarnings: -1,
    quiet: false,
    stdin: false,
    stdinFilename: null,
    help: args.length === 0,
    version: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '--fix') out.fix = true;
    else if (a === '--fix-dry-run') out.fixDryRun = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--no-config-lookup') out.configLookup = false;
    else if (a === '-c' || a === '--config') out.config = valueOf(args, i++, a);
    else if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
    else if (a === '--rule') out.rules = parseRules(valueOf(args, i++, a));
    else if (a.startsWith('--rule=')) out.rules = parseRules(a.slice('--rule='.length));
    else if (a === '-f' || a === '--format') out.format = valueOf(args, i++, a);
    else if (a.startsWith('--format=')) out.format = a.slice('--format='.length);
    else if (a === '--ext') out.extensions = parseExtensions(valueOf(args, i++, a));
    else if (a.startsWith('--ext=')) out.extensions = parseExtensions(a.slice('--ext='.length));
    else if (a === '--max-warnings') out.maxWarnings = parseCount(valueOf(args, i++, a), a);
    else if (a.startsWith('--max-warnings=')) {
      out.maxWarnings = parseCount(a.slice('--max-warnings='.length), '--max-warnings');
    } else if (a === '--stdin-filename') out.stdinFilename = valueOf(args, i++, a);
    else if (a.startsWith('--stdin-filename=')) {
      out.stdinFilename = a.slice('--stdin-filename='.length);
    } else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else out.paths.push(a);
  }
  if (out.fix && out.fixDryRun) throw new Error('--fix and --fix-dry-run cannot be used together');
  if (out.stdinFilename) out.stdin = true;
  // Piped code has no file to write back to, so the real CLI refuses rather
  // than guessing. Without this, `--fix` would target the VIRTUAL stdin
  // filename and overwrite whatever real file it names.
  if (out.stdin && out.fix) {
    throw new Error(
      'The --fix option is not available for piped-in code; use --fix-dry-run instead.'
    );
  }
  if (!['stylish', 'json', 'compact'].includes(out.format)) {
    throw new Error(`unknown formatter: ${out.format} (expected stylish, json, or compact)`);
  }
  return out;
}

function parseRules(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`--rule is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--rule must be a JSON object of ruleId -> severity/options');
  }
  return parsed;
}

function parseExtensions(value) {
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));
  if (list.length === 0) throw new Error('--ext requires at least one extension');
  return list;
}

function parseCount(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${flag} requires an integer`);
  return n;
}

/* ------------------------------ path helpers ------------------------------ */

function dirOf(path) {
  const i = path.lastIndexOf('/');
  if (i <= 0) return '/';
  return path.slice(0, i);
}

function resolvePath(path) {
  const abs = path.startsWith('/') ? path : `${process.cwd().replace(/\/$/, '')}/${path}`;
  const parts = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

async function statOrNull(path) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

function hasLintableExtension(path, extensions) {
  return extensions.some((ext) => path.endsWith(ext));
}

async function walkDir(dir, extensions, out) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
    const st = await statOrNull(full);
    if (!st) continue;
    if (st.isDirectory) await walkDir(full, extensions, out);
    else if (hasLintableExtension(full, extensions)) out.push(full);
  }
}

/**
 * Expand file/dir arguments into a sorted, deduped list of concrete files.
 * `explicit` records whether a path was NAMED on the command line rather than
 * found by walking a directory — the two are reported differently when the
 * config ignores the file.
 */
async function expandTargets(paths, extensions) {
  const explicit = new Set();
  const walked = [];
  const missing = [];
  for (const raw of paths) {
    const abs = resolvePath(raw);
    const st = await statOrNull(abs);
    if (!st) {
      missing.push(raw);
      continue;
    }
    if (st.isDirectory) await walkDir(abs, extensions, walked);
    else explicit.add(abs);
  }
  const all = [...new Set([...explicit, ...walked])].sort();
  return { files: all.map((path) => ({ path, explicit: explicit.has(path) })), missing };
}

/* ---------------------------- config discovery ---------------------------- */

async function discoverConfig(startDir) {
  let dir = startDir;
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const st = await statOrNull(candidate);
      if (st && !st.isDirectory) return candidate;
    }
    if (dir === '/') return null;
    dir = dirOf(dir);
  }
}

/* ------------------------------ helper script ----------------------------- */

/**
 * Build the helper source. `configPath` is embedded as a `require()` LITERAL
 * so the host resolves it while building the helper's module graph; a runtime
 * path would have no graph edge and could never load.
 */
function helperSource(configPath) {
  const configLine =
    configPath === null
      ? 'const loadedConfig = null;'
      : `const loadedConfig = require(${JSON.stringify(configPath)});`;
  return `${configLine}
const { Linter } = require('eslint/universal');
const { minimatch } = require('minimatch');
const fs = require('fs');
const pkg = require('eslint/package.json');

const WRAP_PREFIX = ${JSON.stringify(WRAP_PREFIX)};
const WRAP_SUFFIX = ${JSON.stringify(WRAP_SUFFIX)};

const req = JSON.parse(process.argv[2]);

// Answered before any config handling: reporting the version must not depend
// on a config existing or being usable.
if (req.op === 'version') {
  process.stdout.write(JSON.stringify({ version: pkg.version }));
  process.exit(0);
}

function asConfigArray(value) {
  const unwrapped = value && value.default !== undefined ? value.default : value;
  if (unwrapped === null || unwrapped === undefined) return [];
  return Array.isArray(unwrapped) ? unwrapped.flat(Infinity) : [unwrapped];
}

const configArray = asConfigArray(loadedConfig);
if (req.rules) {
  // A file has to be matched by some entry with a NON-universal \`files\`
  // pattern or ESLint answers "No matching configuration found". With a config
  // file present the inline rules layer on top of its matching entries. With
  // no config file they are all there is, so they carry the matcher — built
  // from the extension list, because ESLint deliberately treats a
  // match-everything pattern like \`**/*\` as universal and it would opt no
  // file in at all.
  configArray.push(
    loadedConfig === null ? { files: req.filePatterns, rules: req.rules } : { rules: req.rules }
  );
}
if (configArray.length === 0) {
  process.stderr.write('empty configuration: nothing to lint with\\n');
  process.exit(2);
}

// Flat config: an entry carrying ONLY \`ignores\` is a GLOBAL ignore.
// \`Linter.verify\` does not apply those, so they are applied here.
const globalIgnores = [];
for (const entry of configArray) {
  if (!entry || typeof entry !== 'object') continue;
  const keys = Object.keys(entry);
  if (keys.length === 1 && keys[0] === 'ignores' && Array.isArray(entry.ignores)) {
    globalIgnores.push(...entry.ignores);
  }
}

function relativeTo(base, path) {
  const prefix = base === '/' ? '/' : base + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// ESLint evaluates ignore patterns IN ORDER, so a later \`!\` re-includes what an
// earlier pattern ignored (\`['**/*.js', '!src/**/*.js']\` lints \`src\`). A
// short-circuiting \`.some()\` cannot express that: it would stop at the first
// positive match and never reach the negation, silently skipping files the user
// asked for — and skipped files make lint PASS, so nothing would look wrong.
function isGloballyIgnored(path) {
  if (globalIgnores.length === 0) return false;
  const rel = relativeTo(req.basePath, path);
  let ignored = false;
  for (const pattern of globalIgnores) {
    if (typeof pattern !== 'string') continue;
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    // A bare directory pattern ignores everything beneath it, as in gitignore.
    const expanded = body.endsWith('/') ? body + '**' : body;
    const hit =
      minimatch(rel, expanded, { dot: true }) ||
      minimatch(rel, expanded + '/**', { dot: true });
    if (hit) ignored = !negated;
  }
  return ignored;
}

// \`files\`/\`ignores\` patterns are relative, and ESLint resolves them against
// the config file's directory. Pass that as the Linter's cwd so a target
// outside the shell's cwd still matches its own config's patterns.
const linter = new Linter({ cwd: req.basePath });

function shouldWrap(path) {
  return path.endsWith('.jsh') || path.endsWith('.bsh');
}

/**
 * Undo the wrapper by stripping the exact prefix and suffix, which is lossless:
 * the body comes back byte-for-byte, trailing newline and all. It doubles as
 * the safety check — a fix that rewrote the wrapper itself (an \`indent\` rule
 * reindents the whole body, so the closing \`}\` moves) no longer matches, and
 * \`null\` tells the caller to leave the file alone rather than write back
 * something reconstructed by guesswork.
 */
function unwrap(text) {
  if (!text.startsWith(WRAP_PREFIX) || !text.endsWith(WRAP_SUFFIX)) return null;
  return text.slice(WRAP_PREFIX.length, text.length - WRAP_SUFFIX.length);
}

async function lintOne(file) {
  const wrap = shouldWrap(file.path);
  const source = wrap ? WRAP_PREFIX + file.source + WRAP_SUFFIX : file.source;
  const result = { path: file.path, messages: [], output: null, wrapUnfixable: false };
  // Wrapped line numbers: 1 is the injected prefix, the body follows, and the
  // last line is the injected suffix.
  const suffixLine = file.source.split('\\n').length + 2;
  /**
   * A finding that lies ENTIRELY in the injected scaffold is about code the
   * user does not have, so reporting it at their line 1 is noise at best and
   * misleading at worst. One that merely STARTS there (a whole-function
   * \`indent\`, say) still concerns their code and is kept, clamped into the body.
   * A fatal is never dropped: if the scaffold itself fails to parse, that is a
   * bug in this command and it has to be visible.
   */
  const isWrapperOnly = (m) => {
    if (m.fatal) return false;
    const start = typeof m.line === 'number' ? m.line : 1;
    const end = typeof m.endLine === 'number' ? m.endLine : start;
    return (start === 1 && end === 1) || (start >= suffixLine && end >= suffixLine);
  };
  const shiftLines = (messages) => {
    if (!wrap) return messages;
    return messages.filter((m) => !isWrapperOnly(m)).map((m) => {
      const shifted = Object.assign({}, m);
      if (typeof shifted.line === 'number') shifted.line = Math.max(1, shifted.line - 1);
      if (typeof shifted.endLine === 'number') shifted.endLine = Math.max(1, shifted.endLine - 1);
      return shifted;
    });
  };

  if (req.fix) {
    const fixed = linter.verifyAndFix(source, configArray, file.path);
    result.messages = shiftLines(fixed.messages);
    if (fixed.fixed) {
      if (!wrap) {
        result.output = fixed.output;
      } else {
        const candidate = unwrap(fixed.output);
        if (candidate === null) result.wrapUnfixable = true;
        else result.output = candidate;
      }
    }
  } else {
    result.messages = shiftLines(linter.verify(source, configArray, file.path));
  }
  return result;
}

async function main() {
  const results = [];
  for (const file of req.files) {
    if (isGloballyIgnored(file.path)) {
      // A path the user NAMED is reported as ignored (ESLint does the same), so
      // a mistyped or newly-ignored argument is not mistaken for a clean file.
      // One found by walking a directory is skipped silently, as intended.
      if (file.explicit) {
        results.push({
          path: file.path,
          messages: [
            {
              ruleId: null,
              severity: 1,
              message: 'File ignored because of a matching ignore pattern.',
              line: 0,
              column: 0,
            },
          ],
          output: null,
          wrapUnfixable: false,
        });
      }
      continue;
    }
    let source = file.source;
    if (source === null) source = await fs.readFile(file.path);
    results.push(await lintOne({ path: file.path, source }));
  }
  process.stdout.write(JSON.stringify(results));
}

await main();
`;
}

/* -------------------------------- reporting ------------------------------- */

function severityName(severity) {
  return severity === 2 ? 'error' : 'warning';
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function formatStylish(results, totals) {
  const lines = [];
  for (const result of results) {
    if (result.messages.length === 0) continue;
    lines.push(result.path);
    const posWidth = Math.max(
      ...result.messages.map((m) => `${m.line ?? 0}:${m.column ?? 0}`.length)
    );
    for (const m of result.messages) {
      const pos = `${m.line ?? 0}:${m.column ?? 0}`;
      const kind = severityName(m.severity);
      const rule = m.ruleId ?? '';
      lines.push(`  ${pad(pos, posWidth)}  ${kind.padEnd(7)}  ${m.message}${rule ? `  ${rule}` : ''}`);
    }
    lines.push('');
  }
  if (totals.problems > 0) {
    const mark = totals.errors > 0 ? '\u2716' : '\u26a0';
    lines.push(
      `${mark} ${totals.problems} problem${totals.problems === 1 ? '' : 's'} ` +
        `(${totals.errors} error${totals.errors === 1 ? '' : 's'}, ` +
        `${totals.warnings} warning${totals.warnings === 1 ? '' : 's'})`
    );
    if (totals.fixableErrors > 0 || totals.fixableWarnings > 0) {
      lines.push(
        `  ${totals.fixableErrors} error${totals.fixableErrors === 1 ? '' : 's'} and ` +
          `${totals.fixableWarnings} warning${totals.fixableWarnings === 1 ? '' : 's'} ` +
          'potentially fixable with the `--fix` option.'
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatCompact(results) {
  const lines = [];
  for (const result of results) {
    for (const m of result.messages) {
      const rule = m.ruleId ? ` (${m.ruleId})` : '';
      lines.push(
        `${result.path}: line ${m.line ?? 0}, col ${m.column ?? 0}, ` +
          `${severityName(m.severity)} - ${m.message}${rule}`
      );
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function formatJson(results, totals) {
  return `${JSON.stringify({
    summary: {
      errors: totals.errors,
      warnings: totals.warnings,
      filesLinted: results.length,
      fixedFiles: totals.fixedFiles,
    },
    results: results.map((r) => ({
      filePath: r.path,
      messages: r.messages,
      errorCount: r.messages.filter((m) => m.severity === 2).length,
      warningCount: r.messages.filter((m) => m.severity === 1).length,
    })),
  })}\n`;
}

function tally(results) {
  const totals = {
    errors: 0,
    warnings: 0,
    problems: 0,
    fixableErrors: 0,
    fixableWarnings: 0,
    fixedFiles: 0,
  };
  for (const result of results) {
    for (const m of result.messages) {
      totals.problems++;
      if (m.severity === 2) {
        totals.errors++;
        if (m.fix) totals.fixableErrors++;
      } else {
        totals.warnings++;
        if (m.fix) totals.fixableWarnings++;
      }
    }
    if (result.output !== null) totals.fixedFiles++;
  }
  return totals;
}

/* ---------------------------------- main ---------------------------------- */

/** Rewrite a helper "Cannot find module 'x'" into the actionable install hint. */
function installHintFor(stderr) {
  const m = stderr.match(/Cannot find module '([^']+)'/);
  if (!m) return null;
  const spec = m[1];
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return `${name} is not installed (run: ${INSTALL_HINT})`;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(e.message, 2);
  return;
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
  return;
}

const tmpDir = process.env.TMPDIR || '/tmp';
const helperPath = `${tmpDir}/.eslint-helper-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;

async function runHelper(request, configPath) {
  await fs.mkdir(tmpDir, { recursive: true }).catch(() => {});
  await fs.writeFile(helperPath, helperSource(configPath));
  try {
    // `exec.spawn` and NOT `exec(string)`: the request carries content this
    // command does not control — stdin bytes and every target's path — and the
    // shell performs command substitution inside double quotes, so a file named
    // `$(...)` or a backtick in a linted buffer would RUN. Quoting cannot fix
    // that (`JSON.stringify` escapes `"` and `\`, never `$` or a backtick); the
    // argv form never builds a command line at all.
    return await exec.spawn(['node', helperPath, JSON.stringify(request)]);
  } finally {
    await fs.unlink(helperPath).catch(() => {});
  }
}

// `--version` reads the installed package and needs no config or targets, so
// it answers before target/config resolution (which would have nothing to
// resolve against).
if (args.version) {
  const versionRun = await runHelper({ op: 'version', files: [], basePath: '/' }, null);
  if (versionRun.exitCode !== 0) {
    fail(installHintFor(versionRun.stderr) ?? versionRun.stderr.trim(), 2);
    return;
  }
  console.log(JSON.parse(versionRun.stdout).version);
  process.exit(0);
  return;
}

// stdin and file targets are mutually exclusive, as in the real CLI.
if (args.stdin && args.paths.length > 0) {
  fail('--stdin cannot be combined with file arguments', 2);
  return;
}
if (!args.stdin && args.paths.length === 0) {
  fail('no files or directories specified (use --help for usage)', 2);
  return;
}

/**
 * Where config discovery starts. For a DIRECTORY target that is the directory
 * itself, not its parent — `eslint .` in a project root must find that root's
 * own config, and starting one level up would walk straight past it.
 */
async function configSearchStart() {
  if (args.stdin) {
    return args.stdinFilename ? dirOf(resolvePath(args.stdinFilename)) : resolvePath('.');
  }
  const first = resolvePath(args.paths[0]);
  const st = await statOrNull(first);
  return st?.isDirectory ? first : dirOf(first);
}

const searchFrom = await configSearchStart();

let configPath = null;
if (args.config !== null) {
  configPath = resolvePath(args.config);
  const st = await statOrNull(configPath);
  if (!st || st.isDirectory) {
    fail(`--config ${args.config}: no such file`, 2);
    return;
  }
} else if (args.configLookup) {
  configPath = await discoverConfig(searchFrom);
}

if (configPath !== null && /\.[cm]?ts$/.test(configPath)) {
  fail(
    `${configPath}: TypeScript flat configs need a loader that is not available here; ` +
      'use a .js/.mjs/.cjs config or pass --config',
    2
  );
  return;
}

if (configPath === null && args.rules === null) {
  fail(
    `no flat config found from ${searchFrom} (looked for ${CONFIG_NAMES.join(', ')}); ` +
      'pass --config <file>, or --no-config-lookup with --rule',
    2
  );
  return;
}

const inputs = [];
let missing = [];
if (args.stdin) {
  const stdinText = await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
  });
  inputs.push({
    path: resolvePath(args.stdinFilename ?? 'stdin.js'),
    source: stdinText,
    explicit: true,
  });
} else {
  const expanded = await expandTargets(args.paths, args.extensions);
  missing = expanded.missing;
  for (const target of expanded.files) {
    inputs.push({ path: target.path, source: null, explicit: target.explicit });
  }
}

for (const name of missing) console.error(`eslint: ${name}: no such file or directory`);

if (inputs.length === 0) {
  if (missing.length > 0) process.exit(2);
  console.error('eslint: no lintable files found');
  process.exit(0);
  return;
}

const request = {
  op: 'lint',
  files: inputs,
  rules: args.rules,
  filePatterns: args.extensions.map((ext) => `**/*${ext}`),
  fix: args.fix || args.fixDryRun,
  // ESLint resolves relative `files`/`ignores` against the config file's
  // directory. With no config file the inline rules are the config, so the
  // base is where discovery started — otherwise a target outside the shell's
  // cwd would match nothing and lint silently clean.
  basePath: configPath === null ? searchFrom : dirOf(configPath),
};

const run = await runHelper(request, configPath);
if (run.exitCode !== 0) {
  fail(installHintFor(run.stderr) ?? (run.stderr.trim() || 'helper failed with no output'), 2);
  return;
}

let results;
try {
  results = JSON.parse(run.stdout);
} catch (e) {
  fail(`could not parse helper output: ${e.message}${run.stderr ? ` (${run.stderr.trim()})` : ''}`, 2);
  return;
}

// A fatal parse error arrives as a message with no ruleId; keep it visible even
// under --quiet, where it would otherwise be filtered out as a warning.
if (args.quiet) {
  for (const result of results) {
    result.messages = result.messages.filter((m) => m.severity === 2 || m.ruleId === null);
  }
}

// Write fixes back through the shell's own fs so every write passes the sudo gate.
// Never for stdin: `result.path` is then the VIRTUAL `--stdin-filename`, chosen
// only so config `files`/`ignores` can select a config, and writing to it would
// overwrite a real project file with a piped buffer (or create `stdin.js`).
// `--fix` with stdin is rejected outright; `--fix-dry-run` prints instead.
if (args.fix && !args.stdin) {
  for (const result of results) {
    if (result.output !== null) await fs.writeFile(result.path, result.output);
  }
}
for (const result of results) {
  if (result.wrapUnfixable) {
    console.error(
      `eslint: ${result.path}: fixes rewrote the script wrapper, so the file was left unchanged`
    );
  }
}

const totals = tally(results);

if (args.format === 'json') process.stdout.write(formatJson(results, totals));
else if (args.format === 'compact') process.stdout.write(formatCompact(results));
else {
  const text = formatStylish(results, totals);
  if (text) process.stdout.write(text);
}

if (args.fixDryRun) {
  for (const result of results) {
    if (result.output === null) continue;
    // Piped code has no file to rewrite, so the fixed buffer IS the result —
    // print it, the way the real CLI does for `--stdin --fix-dry-run`.
    if (args.stdin) process.stdout.write(result.output);
    else console.error(`eslint: ${result.path}: --fix would rewrite`);
  }
}

if (missing.length > 0) process.exit(2);
if (totals.errors > 0) process.exit(1);
if (!args.quiet && args.maxWarnings >= 0 && totals.warnings > args.maxWarnings) {
  console.error(
    `eslint: ${totals.warnings} warning${totals.warnings === 1 ? '' : 's'} ` +
      `exceeded the --max-warnings limit of ${args.maxWarnings}`
  );
  process.exit(1);
}
process.exit(0);
