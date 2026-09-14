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

const BOOL_FLAGS = new Set(['video', 'help']);

export const LEADER_ORIGIN_RE = /(?:localhost|127\.0\.0\.1):(?:8787|57\d\d)\b/;

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

export function targetMatchesUrl(url, filter) {
  if (!filter) return true;
  const u = url || '';
  if (filter.isRegex) {
    try {
      return new RegExp(filter.value).test(u);
    } catch {
      return false;
    }
  }
  return u.includes(filter.value);
}

export function pickPageTarget(targets, filter) {
  const pages = (targets || []).filter((t) => t.type === 'page');
  if (pages.length === 0) return undefined;
  if (filter) {
    return pages.find((t) => targetMatchesUrl(t.url, filter));
  }
  const leader = pages.find((t) => LEADER_ORIGIN_RE.test(t.url || ''));
  if (leader) return leader;
  const httpPage = pages.find((t) => /^https?:\/\//.test(t.url || ''));
  return httpPage ?? pages[0];
}

export function frameFilename(seq, format = 'jpeg') {
  const ext = format === 'png' ? 'png' : 'jpeg';
  return `frame-${String(seq).padStart(6, '0')}.${ext}`;
}

export function urlFilterFromOptions(opts) {
  if (!opts.url) return null;
  return { value: opts.url, isRegex: Boolean(opts.urlIsRegex) };
}
