# jsh runtime extensions

This file is bundled into the agent VFS at `/workspace/skills/skill-authoring/jsh-runtime-extensions.md`. Developer-facing equivalent: `docs/shell-reference.md` (which lives outside the VFS). Keep both in sync when the runtime surface changes.

## Runtime globals (Globals API)

Every `.jsh` script runs in an async wrapper with these globals available. Prefer them over hand-rolled equivalents.

| Global                      | Purpose                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process`                   | `argv` (with `.parseFlags()`), `env`, `cwd()`, `exit(code)`, `stdout.write`, `stderr.write`, `stdin.read()` / async iterator. `stdin` buffer is one-shot — drain or iterate once. |
| `console`                   | `log`/`info` → stdout, `warn`/`error` → stderr.                                                                                                                                   |
| `fs`                        | `readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile(url, path)` — all paths are VFS, all async.                |
| `exec(cmd)`                 | Run any shell command, returns `{ stdout, stderr, exitCode }`. Also `exec.spawn(argv[])` to bypass shell parsing.                                                                 |
| `fetch`                     | Standard `fetch` routed through SLICC's proxied transport (cookies + CORS + secret masking handled).                                                                              |
| `require(p)`                | Pull npm packages from esm.sh; version-pinnable (`require('lodash@4')`); cached per session.                                                                                      |
| `process.argv.parseFlags()` | Parse `--flag=val` / `--flag val` / `-x` / positional / `--` passthrough into `{ positional, flags, subcommand, passthrough }`.                                                   |
| `cli`                       | `die(msg, code?)`, `out(value)`, `warn(msg)`, `help(text)` — stdout/stderr/exit helpers.                                                                                          |
| `c`                         | ANSI color helpers: `green`, `red`, `yellow`, `gray`, `bold`, `cyan`, `dim`, plus `enabled` flag (auto-disabled on non-TTY / `NO_COLOR`).                                         |
| `time`                      | `parseDuration(spec)`, `ago(spec)`, `range(spec)`, `future(spec)`, `gmailDate(spec)`. Units: `ms s m h d w M y` (note: `m` = minutes, `M` = months).                              |
| `fmt`                       | `trunc(s, n)`, `col(s, width)`, `table(rows, widths?)`, `date(value, style?)` — ANSI-width-aware formatters.                                                                      |
| `pool`                      | `pool(n, items, fn)` — bounded concurrency runner, results returned in input order.                                                                                               |

### Examples for the non-trivial globals

```javascript
// process.argv.parseFlags() — replace per-skill arg loops
const { positional, flags, subcommand, passthrough } = process.argv.parseFlags();
// e.g. `mycli send --to alice --json -- --raw` →
//   positional: ['send', 'alice'], flags: { to: 'alice', json: true },
//   subcommand: 'send', passthrough: ['--raw']

// cli + c — early-exit helpers and color
if (!flags.to) cli.die('--to is required'); // writes "Error: …" to stderr, exits 1
cli.out({ ok: true }); // pretty-prints JSON to stdout with trailing newline
console.log(c.green('✓'), c.dim('done'));

// time — duration math
const since = time.ago('7d'); // Date 7 days ago
const q = `after:${time.gmailDate('7d')}`; // "after:2026/05/22"

// fmt — ANSI-aware table
console.log(
  fmt.table([
    ['name', 'status'],
    ['hub', c.green('up')],
    ['relay', c.red('down')],
  ])
);

// pool — bounded concurrency
const results = await pool(4, urls, async (url) => (await fetch(url)).status);
```

## jsh runtime extensions

The following globals collapse the boilerplate that 18 of 23 surveyed skills reinvented. They're available in both standalone and extension floats.

### `skill.*` — script-relative paths, config, tokens

Computed once at boot from `argv[1]` and frozen. Replaces ad-hoc `process.argv[1].substring(0, …)` dirname math, bespoke `.config` JSON readers, and `oauth-token` shell-outs.

```typescript
skill.dir: string                                              // directory containing the running script
skill.refs: string                                             // `<dir>/references`
skill.assets: string                                           // `<dir>/assets`
skill.config(): Promise<Record<string, unknown> | null>        // read parsed JSON from `<dir>/.config`
skill.config(updates): Promise<Record<string, unknown>>        // shallow-merge + write, returns merged
skill.token(providerId: string): Promise<string>               // shells out to `oauth-token <id>`
```

```javascript
const cfg = (await skill.config()) ?? {};
const token = await skill.token('adobe');
const tmpl = await fs.readFile(`${skill.refs}/prompt.md`);
```

### `browser.*` — page-context CDP bridge

Replaces the `exec('playwright-cli tab-list')` shell-out + regex parse used in ~12 skills. Accepts a `TabHandle` (from `findTab` / `ensureTab`) or a bare `targetId` string. `eval` / `evalAsync` serialize functions to a string call expression so realm code can pass a closure as ergonomically as a string.

```typescript
browser.findTab(opts: { domain?: string; urlMatch?: RegExp | string }): Promise<TabHandle | null>
browser.ensureTab(url: string, opts?: { matchUrl?: RegExp | string }): Promise<TabHandle>
browser.eval(tab, fn: Function | string): Promise<unknown>      // sync expression
browser.evalAsync(tab, fn: AsyncFunction): Promise<unknown>     // async, returns parsed JSON
browser.cookie(tab, name: string): Promise<string | null>
browser.localStorage(tab, key: string): Promise<string | null>
```

```javascript
const tab = await browser.findTab({ domain: 'slack.com' });
if (!tab) cli.die('open slack.com first');
const team = await browser.eval(tab, () => document.title);
const xoxc = await browser.localStorage(tab, 'localConfig_v2');
```

### `browser.fetch(tab, url, opts)` — page-context fetch

Replaces the eval-file + base64 + double-JSON-unwrap pattern in ~9 skills. Runs inside the tab's origin, so **session cookies and same-origin headers are automatic** — don't try to forward cookies manually.

```typescript
browser.fetch(tab: TabHandle | string, url: string, opts?: {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | ...;
  headers?: Record<string, string>;
  body?: unknown;                   // object → JSON-stringified
  credentials?: 'include' | 'omit'; // defaults to 'include'
}): Promise<{ ok: boolean; status: number; headers: Record<string, string>; body: unknown }>
```

```javascript
const resp = await browser.fetch(tab, '/api/conversations.list', {
  method: 'POST',
  body: { limit: 100 },
});
if (!resp.ok) cli.die(`slack ${resp.status}`);
const channels = resp.body.channels;
```

### `browser.websocket` — declarative WebSocket observer

Sanctioned replacement for `WebSocket.prototype.send` monkey-patches. **REQUIRED for any new WS-watch use case** — skill code MUST NOT author page-context functions that patch a third-party page's prototypes or see the inbound frame firehose.

```typescript
const sub = await browser.websocket
  .on(tab, { urlMatch: /wss-primary\.slack\.com/ })
  .filter({ parseAs: 'json', where: { type: 'message', channel: 'C0899S7HV0E' } })
  .forward({ sink: 'webhook', webhookId: 'slack-watch-abc123' });

await sub.update({ filter: { where: { channel: 'C-new' } } });
await sub.close();
await browser.websocket.list();
```

**Sink set is a closed enum.** The page-side router (runtime-owned, audited once) only knows how to forward matched frames to:

- `'webhook'` — resolved against the existing `webhook` registry; an unknown `webhookId` rejects at subscriber-creation time.
- `'scoop'` — delivered via the orchestrator's scoop dispatch.
- `'vfs'` — appended to an absolute path that must start with `/workspace/`.
- `'log'` — telemetry only.

Skills cannot supply an arbitrary URL, cannot supply page-context code (the `filter` selector is a declarative JSON object — `parseAs`, `where`, `project` — and the realm rejects functions or strings of JS at the boundary), and cannot intercept outbound `send` traffic. Subscribers owned by a scoop auto-close when the scoop is dropped.

### `http.client({ baseUrl, token, headers, retry })` — standard API-client builder

Standardizes the `build URL → merge headers → resolve auth → fetch → unwrap JSON → throw on !ok` boilerplate. `token` is **lazy** — resolved freshly per request so token rotation / refresh hooks are picked up without recreating the client. Backoff is exponential, but **`Retry-After` (when present and parseable, in seconds or HTTP date) takes precedence** — the server knows its own rate limit.

```typescript
http.client(config: {
  baseUrl?: string;
  token?: () => string | Promise<string | null | undefined>;
  headers?: Record<string, string>;
  retry?: { on: number[]; maxAttempts: number };  // maxAttempts is total (including first)
}): {
  get(path, opts?):    Promise<unknown>;
  post(path, opts?):   Promise<unknown>;
  put(path, opts?):    Promise<unknown>;
  delete(path, opts?): Promise<unknown>;
}
// opts: { params?, headers?, body? }  — `body` object → JSON, params → querystring
```

```javascript
const api = http.client({
  baseUrl: 'https://graph.microsoft.com/v1.0',
  token: () => skill.token('microsoft'),
  headers: { Accept: 'application/json' },
  retry: { on: [429, 503], maxAttempts: 4 },
});

const me = await api.get('/me');
const sent = await api.post('/me/sendMail', {
  body: {
    message: {
      /* … */
    },
  },
});
// Non-2xx throws `HttpError` with { status, statusText, url, body }.
```
