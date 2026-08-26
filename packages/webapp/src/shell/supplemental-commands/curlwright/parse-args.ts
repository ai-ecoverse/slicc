/**
 * `curlwright` argv parsing — curl's option surface, nothing else.
 *
 * The parser is deliberately hand-rolled rather than routed through
 * `arg-parser.ts`/`mri`: curl's grammar has bundled short booleans
 * (`-sS`), attached short values (`-XPOST`, `-oout.bin`), repeatable
 * value flags (`-H` … `-H` …) and an ORDER-SENSITIVE `-d` list. `mri`
 * models none of those, and — more importantly — it silently accepts
 * anything, which is exactly the failure mode this command must not
 * have: an option curl understands but a browser cannot honor
 * (`--cert`, `-x`, `--resolve`) has to fail loudly instead of being
 * quietly dropped, because the whole point of the command is that the
 * request goes out *exactly* as written.
 *
 * The same reasoning excludes the shared `parseKnownFlags` walk added for
 * issue #2255, and this command is NOT part of that sweep: it already
 * rejects unknown flags by name, which is what #2255 is trying to
 * achieve. That helper collects values into a `Map`, so a repeated flag
 * overwrites — `-H` and `-d` here are repeatable AND order-sensitive —
 * and it has no notion of bundled short booleans, attached short values,
 * or a `-X`/`--request` alias pair, so `-sS` and `-XPOST` would both come
 * back as unknown flags. Its single `unknown flag: --x` message also
 * cannot carry the per-option reason (`--cert` vs `-x` vs `--compressed`)
 * that makes a rejection here actionable. The enforcement is not this
 * comment: `curlwright-args.test.ts` pins `-sS`, `-XPOST` and the ordered
 * repeat of `-H`/`-d`, so a migration to the helper fails there first.
 *
 * Parsing is pure: `@file` references are recorded, never read. The
 * command resolves them against the VFS afterwards (see `body.ts`), so
 * this module stays trivially testable.
 */

/** One `-d`/`--data-*`/`--json` argument, in the order it was given. */
export interface DataSpec {
  /** Which `--data-*` variant produced this part; drives newline stripping. */
  kind: 'ascii' | 'binary' | 'raw' | 'urlencode' | 'json';
  /** The verbatim argument, `@file` prefix included. */
  value: string;
}

/** One `-F`/`--form` argument, unparsed (the `;type=` grammar lives in `form.ts`). */
export interface FormSpec {
  value: string;
  /** `--form-string` — the value is literal, `@`/`<` are not special. */
  literal: boolean;
}

/** A single `-H` header, already split on the first `:`. */
export interface HeaderSpec {
  name: string;
  value: string;
  /** `-H 'Name:'` — curl's "unset this header" form; a browser has none to unset. */
  unset: boolean;
}

/** Everything `curlwright`'s argv can express, normalized. */
export interface CurlwrightOptions {
  url: string | null;
  requestMethod: string | null;
  headers: HeaderSpec[];
  data: DataSpec[];
  form: FormSpec[];
  get: boolean;
  output: string | null;
  remoteName: boolean;
  include: boolean;
  head: boolean;
  dumpHeader: string | null;
  writeOut: string | null;
  silent: boolean;
  showError: boolean;
  verbose: boolean;
  failOnError: boolean;
  maxTimeSeconds: number | null;
  credentials: 'include' | 'omit';
  tab: string | null;
  frame: string | null;
  user: string | null;
  referer: string | null;
  range: string | null;
  help: boolean;
}

export interface ParseFailure {
  message: string;
  /** curl exits 2 on an option it cannot initialize from. */
  exitCode: 2;
}

/** Long options that consume a value, mapped to their canonical key. */
const LONG_VALUE_FLAGS = new Set([
  'request',
  'header',
  'data',
  'data-raw',
  'data-binary',
  'data-ascii',
  'data-urlencode',
  'json',
  'form',
  'form-string',
  'output',
  'dump-header',
  'write-out',
  'max-time',
  'user',
  'referer',
  'range',
  'url',
  'tab',
  'frame',
]);

/** Long options that are pure booleans. */
const LONG_BOOL_FLAGS = new Set([
  'silent',
  'show-error',
  'include',
  'head',
  'verbose',
  'fail',
  'location',
  'remote-name',
  'get',
  'no-credentials',
  'help',
]);

/** Short options that consume a value (attached or as the next token). */
const SHORT_VALUE_FLAGS: Record<string, string> = {
  X: 'request',
  H: 'header',
  d: 'data',
  F: 'form',
  o: 'output',
  D: 'dump-header',
  w: 'write-out',
  m: 'max-time',
  u: 'user',
  e: 'referer',
  r: 'range',
};

/** Short options that are pure booleans (bundleable: `-sSL`). */
const SHORT_BOOL_FLAGS: Record<string, string> = {
  s: 'silent',
  S: 'show-error',
  i: 'include',
  I: 'head',
  v: 'verbose',
  f: 'fail',
  L: 'location',
  O: 'remote-name',
  G: 'get',
  h: 'help',
};

/**
 * curl options that are real, but cannot mean anything inside a page
 * context — each with the reason and, where one exists, the thing to
 * reach for instead. Rejecting these loudly is a requirement, not a
 * nicety: silently ignoring `--insecure` or `-x` would make the command
 * lie about what it sent.
 */
const REJECTED_FLAGS: Record<string, string> = {
  cert: "client certificates are the browser profile's to present, not the shell's",
  'cert-type': "client certificates are the browser profile's to present, not the shell's",
  key: "client certificates are the browser profile's to present, not the shell's",
  cacert: 'the browser decides which roots to trust',
  capath: 'the browser decides which roots to trust',
  insecure: 'the browser enforces TLS verification; a page cannot opt out',
  proxy: 'proxying is configured on the browser, not per request',
  'proxy-user': 'proxying is configured on the browser, not per request',
  interface: 'a page cannot choose an outgoing interface',
  'unix-socket': 'a page cannot dial a unix socket',
  resolve: 'a page cannot override DNS resolution',
  compressed: 'always on — the browser negotiates encoding itself',
  cookie: "the tab's own cookies are already sent; set one with `playwright-cli cookie-set`",
  'cookie-jar': 'cookies live in the browser profile; read them with `playwright-cli cookies`',
  'limit-rate': 'a page cannot throttle a fetch',
  'continue-at': "a page fetch cannot resume; use `-H 'Range: bytes=N-'`",
  'connect-timeout': 'a page fetch cannot time the connect phase alone; use `--max-time`',
  'http1.1': 'the browser negotiates the HTTP version',
  http2: 'the browser negotiates the HTTP version',
  http3: 'the browser negotiates the HTTP version',
  'no-buffer': 'responses are read whole, never streamed to stdout',
  'trace-ascii': 'no wire trace exists; use `playwright-cli network-requests`',
  trace: 'no wire trace exists; use `playwright-cli network-requests`',
  'user-agent': 'User-Agent is a forbidden header name for fetch(); the tab sets it',
};

/** Short aliases of rejected long options, so `-k` and `-x` fail the same way. */
const REJECTED_SHORT_FLAGS: Record<string, string> = {
  k: 'insecure',
  x: 'proxy',
  b: 'cookie',
  c: 'cookie-jar',
  E: 'cert',
  C: 'continue-at',
  N: 'no-buffer',
  A: 'user-agent',
};

function emptyOptions(): CurlwrightOptions {
  return {
    url: null,
    requestMethod: null,
    headers: [],
    data: [],
    form: [],
    get: false,
    output: null,
    remoteName: false,
    include: false,
    head: false,
    dumpHeader: null,
    writeOut: null,
    silent: false,
    showError: false,
    verbose: false,
    failOnError: false,
    maxTimeSeconds: null,
    credentials: 'include',
    tab: null,
    frame: null,
    user: null,
    referer: null,
    range: null,
    help: false,
  };
}

function rejection(flag: string, canonical: string): ParseFailure {
  return {
    message: `curlwright: option ${flag} is not supported in a page context — ${REJECTED_FLAGS[canonical]}`,
    exitCode: 2,
  };
}

function unknown(flag: string): ParseFailure {
  return {
    message: `curlwright: unknown option ${flag}\nRun 'curlwright --help' for the supported flags.`,
    exitCode: 2,
  };
}

/** Split `-H` input on its first colon; `Name;` is curl's empty-value form. */
function parseHeader(raw: string): HeaderSpec {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    return raw.endsWith(';')
      ? { name: raw.slice(0, -1).trim(), value: '', unset: false }
      : { name: raw.trim(), value: '', unset: false };
  }
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  return { name, value, unset: value === '' };
}

/** Apply one canonical option (long name) plus its value, in place. */
function applyOption(
  opts: CurlwrightOptions,
  name: string,
  value: string | null,
  token: string
): ParseFailure | null {
  switch (name) {
    case 'request':
      opts.requestMethod = value;
      return null;
    case 'header':
      opts.headers.push(parseHeader(value ?? ''));
      return null;
    case 'data':
    case 'data-ascii':
      opts.data.push({ kind: 'ascii', value: value ?? '' });
      return null;
    case 'data-raw':
      opts.data.push({ kind: 'raw', value: value ?? '' });
      return null;
    case 'data-binary':
      opts.data.push({ kind: 'binary', value: value ?? '' });
      return null;
    case 'data-urlencode':
      opts.data.push({ kind: 'urlencode', value: value ?? '' });
      return null;
    case 'json':
      opts.data.push({ kind: 'json', value: value ?? '' });
      return null;
    case 'form':
      opts.form.push({ value: value ?? '', literal: false });
      return null;
    case 'form-string':
      opts.form.push({ value: value ?? '', literal: true });
      return null;
    case 'output':
      opts.output = value;
      return null;
    case 'dump-header':
      opts.dumpHeader = value;
      return null;
    case 'write-out':
      opts.writeOut = value;
      return null;
    case 'max-time':
      return applyMaxTime(opts, value, token);
    case 'user':
      opts.user = value;
      return null;
    case 'referer':
      opts.referer = value;
      return null;
    case 'range':
      opts.range = value;
      return null;
    case 'url':
      opts.url = value;
      return null;
    case 'tab':
      opts.tab = value;
      return null;
    case 'frame':
      opts.frame = value;
      return null;
    default:
      return applyBooleanOption(opts, name, token);
  }
}

function applyMaxTime(
  opts: CurlwrightOptions,
  value: string | null,
  token: string
): ParseFailure | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { message: `curlwright: ${token} expects a positive number of seconds`, exitCode: 2 };
  }
  opts.maxTimeSeconds = seconds;
  return null;
}

function applyBooleanOption(
  opts: CurlwrightOptions,
  name: string,
  token: string
): ParseFailure | null {
  switch (name) {
    case 'silent':
      opts.silent = true;
      return null;
    case 'show-error':
      opts.showError = true;
      return null;
    case 'include':
      opts.include = true;
      return null;
    case 'head':
      opts.head = true;
      return null;
    case 'verbose':
      opts.verbose = true;
      return null;
    case 'fail':
      opts.failOnError = true;
      return null;
    // `-L` is accepted and is already the behavior: a page `fetch` follows
    // redirects and cannot expose the intermediate 3xx, so there is nothing
    // to turn on. See the note in `--help`.
    case 'location':
      return null;
    case 'remote-name':
      opts.remoteName = true;
      return null;
    case 'get':
      opts.get = true;
      return null;
    case 'no-credentials':
      opts.credentials = 'omit';
      return null;
    case 'help':
      opts.help = true;
      return null;
    default:
      return unknown(token);
  }
}

/** Walk a long (`--name` / `--name=value`) token. Returns the new arg index. */
function consumeLong(
  opts: CurlwrightOptions,
  args: string[],
  index: number
): { next: number } | ParseFailure {
  const token = args[index];
  const eq = token.indexOf('=');
  const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
  const inline = eq === -1 ? null : token.slice(eq + 1);

  if (name in REJECTED_FLAGS) return rejection(`--${name}`, name);
  if (LONG_VALUE_FLAGS.has(name)) {
    const value = inline ?? args[index + 1];
    if (value === undefined) {
      return { message: `curlwright: option --${name} requires a value`, exitCode: 2 };
    }
    const failure = applyOption(opts, name, value, `--${name}`);
    return failure ?? { next: inline === null ? index + 2 : index + 1 };
  }
  if (!LONG_BOOL_FLAGS.has(name)) return unknown(`--${name}`);
  const failure = applyOption(opts, name, null, `--${name}`);
  return failure ?? { next: index + 1 };
}

/**
 * Walk a short token, which may bundle several booleans and end in one
 * value-taking option (`-sSo out.bin`, `-XPOST`). Returns the new index.
 */
function consumeShort(
  opts: CurlwrightOptions,
  args: string[],
  index: number
): { next: number } | ParseFailure {
  const token = args[index];
  for (let cursor = 1; cursor < token.length; cursor++) {
    const letter = token[cursor];
    if (letter in REJECTED_SHORT_FLAGS) {
      return rejection(`-${letter}`, REJECTED_SHORT_FLAGS[letter]);
    }
    if (letter in SHORT_VALUE_FLAGS) {
      const attached = token.slice(cursor + 1);
      const value = attached !== '' ? attached : args[index + 1];
      if (value === undefined) {
        return { message: `curlwright: option -${letter} requires a value`, exitCode: 2 };
      }
      const failure = applyOption(opts, SHORT_VALUE_FLAGS[letter], value, `-${letter}`);
      return failure ?? { next: attached !== '' ? index + 1 : index + 2 };
    }
    if (!(letter in SHORT_BOOL_FLAGS)) return unknown(`-${letter}`);
    const failure = applyOption(opts, SHORT_BOOL_FLAGS[letter], null, `-${letter}`);
    if (failure) return failure;
  }
  return { next: index + 1 };
}

/** Record a bare (non-flag) argument as the URL; a second one is an error. */
function consumePositional(opts: CurlwrightOptions, token: string): ParseFailure | null {
  if (opts.url !== null && opts.url !== token) {
    return {
      message: `curlwright: only one URL is supported (got "${opts.url}" and "${token}")`,
      exitCode: 2,
    };
  }
  opts.url = token;
  return null;
}

/**
 * Parse a `curlwright` argv into {@link CurlwrightOptions}, or a
 * {@link ParseFailure} naming the offending flag. `--` ends option
 * parsing, matching curl.
 */
export function parseCurlwrightArgs(args: string[]): CurlwrightOptions | ParseFailure {
  const opts = emptyOptions();
  let index = 0;
  let optionsEnded = false;

  while (index < args.length) {
    const token = args[index];
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      index++;
      continue;
    }
    if (!optionsEnded && token.startsWith('--')) {
      const step = consumeLong(opts, args, index);
      if ('message' in step) return step;
      index = step.next;
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token.length > 1) {
      const step = consumeShort(opts, args, index);
      if ('message' in step) return step;
      index = step.next;
      continue;
    }
    const failure = consumePositional(opts, token);
    if (failure) return failure;
    index++;
  }
  return opts;
}

/** Type guard separating a parse failure from a parsed option set. */
export function isParseFailure(value: CurlwrightOptions | ParseFailure): value is ParseFailure {
  return 'message' in value;
}

/**
 * Header names `fetch()` refuses to let a page set (the Fetch spec's
 * forbidden request headers). Passing one is a hard error rather than a
 * warning: the browser drops it silently, so the request would go out
 * differing from what was typed — which defeats the point of a command
 * whose contract is "exactly what I wrote, from inside the page".
 */
const FORBIDDEN_HEADERS: Record<string, string> = {
  'accept-charset': 'the browser sets it',
  'accept-encoding': 'the browser negotiates encoding',
  connection: 'the browser owns the connection',
  'content-length': 'derived from the body',
  cookie: "the tab's cookies are sent already; set one with `playwright-cli cookie-set`",
  cookie2: "the tab's cookies are sent already",
  date: 'the browser sets it',
  dnt: 'the browser sets it',
  expect: 'a page fetch cannot send it',
  host: 'derived from the URL',
  'keep-alive': 'the browser owns the connection',
  origin: "the tab's own origin is sent automatically",
  referer: 'use -e/--referer, which sets the fetch referrer',
  te: 'the browser owns transfer encoding',
  trailer: 'the browser owns transfer encoding',
  'transfer-encoding': 'the browser owns transfer encoding',
  upgrade: 'the browser owns the connection',
  via: 'the browser sets it',
};

function forbiddenReason(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower in FORBIDDEN_HEADERS) return FORBIDDEN_HEADERS[lower];
  if (lower.startsWith('proxy-')) return 'proxying is configured on the browser';
  if (lower.startsWith('sec-')) return 'Sec- headers are reserved for the browser';
  return null;
}

/**
 * Reject any `-H` the browser would silently strip. Returns `null` when
 * every header can actually be sent.
 */
export function validateHeaders(headers: HeaderSpec[]): ParseFailure | null {
  for (const header of headers) {
    const reason = forbiddenReason(header.name);
    if (reason) {
      return {
        message: `curlwright: header "${header.name}" cannot be set from a page — ${reason}`,
        exitCode: 2,
      };
    }
  }
  return null;
}
