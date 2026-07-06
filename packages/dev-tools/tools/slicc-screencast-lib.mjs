// slicc-screencast-lib.mjs — pure helpers for the CDP screencast recorder.
//
// Split out from slicc-screencast.mjs so the argv parsing + target-picking +
// frame-naming logic is unit-testable without a live Chrome (mirrors the
// slicc-debug.mjs / slicc-debug.test.mjs split). No I/O, no CDP here.

/** Flags that consume the following argv token as their value. */
const VALUE_FLAGS = new Set([
  'out',
  'port',
  'url',
  'url-pattern',
  'duration',
  'format',
  'quality',
  'max-width',
  'max-height',
  'every-nth',
  'fps',
]);

/** Boolean flags (presence = true). */
const BOOL_FLAGS = new Set(['video', 'help']);

/**
 * Split argv into recognized flags and positional tokens. Supports both
 * `--flag value` and `--flag=value` forms for value-flags; boolean flags take
 * no value. Unknown `--tokens` are preserved as positionals.
 */
export function parseArgv(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        flags[name] = eq === -1 ? args[++i] : a.slice(eq + 1);
        continue;
      }
    }
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * Resolve recorder options from parsed flags, applying defaults + numeric
 * coercion. `now` is injectable so the default out-dir stamp is deterministic
 * in tests.
 */
export function resolveOptions(flags = {}, { now = () => Date.now() } = {}) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  return {
    out: flags.out ?? `/tmp/slicc-screencast/${stamp}`,
    port: flags.port ?? process.env.SLICC_CDP_PORT ?? null,
    url: flags['url-pattern'] ?? flags.url ?? process.env.SLICC_TARGET_URL ?? null,
    urlIsRegex: flags['url-pattern'] !== undefined,
    durationMs: flags.duration !== undefined ? Math.round(Number(flags.duration) * 1000) : null,
    format: flags.format === 'png' ? 'png' : 'jpeg',
    quality: flags.quality !== undefined ? Number(flags.quality) : 80,
    maxWidth: flags['max-width'] !== undefined ? Number(flags['max-width']) : 1280,
    maxHeight: flags['max-height'] !== undefined ? Number(flags['max-height']) : 800,
    everyNth: flags['every-nth'] !== undefined ? Number(flags['every-nth']) : 1,
    video: flags.video === true,
    fps: flags.fps !== undefined ? Number(flags.fps) : 10,
  };
}

/** Does a target URL satisfy the `--url` / `--url-pattern` filter? */
export function targetMatchesUrl(url, filter) {
  if (!filter) return true;
  const u = url || '';
  return filter.isRegex ? new RegExp(filter.value).test(u) : u.includes(filter.value);
}

/**
 * Pick the page target to record. Prefers an explicit URL filter match; then a
 * real http(s) page (over about:blank / devtools / chrome:// scaffolding);
 * falls back to the first page. Returns undefined when there is no page target.
 */
export function pickPageTarget(targets, filter) {
  const pages = (targets || []).filter((t) => t.type === 'page');
  if (pages.length === 0) return undefined;
  if (filter) {
    const matched = pages.filter((t) => targetMatchesUrl(t.url, filter));
    if (matched.length >= 1) return matched[0];
  }
  const httpPage = pages.find((t) => /^https?:\/\//.test(t.url || ''));
  return httpPage ?? pages[0];
}

/** Zero-padded per-frame filename, e.g. frame-000042.jpeg. */
export function frameFilename(seq, format = 'jpeg') {
  const ext = format === 'png' ? 'png' : 'jpeg';
  return `frame-${String(seq).padStart(6, '0')}.${ext}`;
}

/** Build the `--url` filter descriptor from resolved options. */
export function urlFilterFromOptions(opts) {
  if (!opts.url) return null;
  return { value: opts.url, isRegex: Boolean(opts.urlIsRegex) };
}
