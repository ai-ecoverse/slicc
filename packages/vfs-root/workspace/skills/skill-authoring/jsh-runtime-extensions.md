# jsh runtime extensions

This file is bundled into the agent VFS at `/workspace/skills/skill-authoring/jsh-runtime-extensions.md`. Developer-facing equivalent: `docs/shell-reference.md` (which lives outside the VFS). Keep both in sync when the runtime surface changes.

## Runtime globals (Globals API)

Every `.jsh` script runs in an async wrapper with a small Node-standard surface available as bare globals. SLICC's capability bridges (exec, agent, http, browser, USB / Serial / HID, skill, color, cli, time, fmt, pool) are NOT bare globals; they are reached via the `sliccy:` virtual-module scheme below.

### Node-standard bare globals

| Global                                                           | Purpose                                                                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process`                                                        | `argv` (with `.parseFlags()`), `env`, `cwd()`, `exit(code)`, `stdout.write`, `stderr.write`, `stdin.read()` / async iterator. `stdin` buffer is one-shot — drain or iterate once.       |
| `console`                                                        | `log`/`info` → stdout, `warn`/`error` → stderr.                                                                                                                                         |
| `fetch`                                                          | Standard `fetch` routed through SLICC's proxied transport (cookies + CORS + secret masking handled).                                                                                    |
| `require(p)`                                                     | Synchronous CJS `require`. Use `require('sliccy:<name>')` for capability bridges, `require('fs')` / `require('node:fs')` for the VFS bridge, `require('<pkg>')` for installed packages. |
| `Buffer` / `globalThis`                                          | Node-standard surface.                                                                                                                                                                  |
| `setTimeout` / `clearTimeout` / `setInterval` / `queueMicrotask` | Web timer surface (also reachable through `globalThis`).                                                                                                                                |
| `__dirname` / `__filename`                                       | CJS scope vars — the running script's own directory and absolute path.                                                                                                                  |
| `module` / `exports`                                             | CJS module record (writeable; useful when a `.jsh` is treated as a library by a sibling `require('./helper.jsh')`).                                                                     |
| `process.argv.parseFlags()`                                      | Parse `--flag=val` / `--flag val` / `-x` / positional / `--` passthrough into `{ positional, flags, subcommand, passthrough }`.                                                         |

### Capability bridges — `sliccy:` virtual modules

The bespoke globals are hard-cut. Reach each capability via `require('sliccy:<name>')` (CJS) or `import ... from 'sliccy:<name>'` (ESM). `require('fs')` / `require('node:fs')` keeps returning the VFS bridge.

| `require('sliccy:<name>')`                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sliccy:exec`                                 | Callable `exec(cmd)` plus `.spawn(argv[])`, `.start(cmdOrArgv, opts?)` (killable, buffered-stdin spawn handle) and `.exec` self-reference. Returns `{ stdout, stderr, exitCode }`. Use `const { exec } = require('sliccy:exec')` or `const exec = require('sliccy:exec')`.                                                                                                                                                 |
| `sliccy:agent`                                | Callable `agent(prompt, opts?)` — spawns a one-shot sub-scoop, feeds it the prompt, blocks until the agent loop completes; resolves to trimmed final text (JSON-parsed when `opts.schema` is set), REJECTS on non-zero exit or schema-parse failure. `.spawn(prompt, opts?)` is the non-throwing variant → `{ finalText, exitCode, stderr }`. `opts`: `model`, `thinking`, `cwd`, `allowedCommands`, `readOnly`, `schema`. |
| `sliccy:skill`                                | Frozen `{ dir, refs, assets, config(), config(updates), token(providerId) }`. Replaces ad-hoc `argv[1]` dirname math and `oauth-token` shell-outs.                                                                                                                                                                                                                                                                         |
| `sliccy:http`                                 | `http.client({ baseUrl, token, headers, retry, timeoutMs })` builder.                                                                                                                                                                                                                                                                                                                                                      |
| `sliccy:browser`                              | `findTab`, `ensureTab`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`, `websocket.on(...).filter(...).forward(...)`.                                                                                                                                                                                                                                                                                              |
| `sliccy:usb` / `sliccy:serial` / `sliccy:hid` | `list()` / `request()` + device methods (`open`/`close`/`sendReport`/...). Chromium-only.                                                                                                                                                                                                                                                                                                                                  |
| `sliccy:cli`                                  | `die(msg, opts?)`, `out(value)`, `warn(msg, opts?)`, `help(text)`. `opts` is `number` or `{ exitCode?, prefix? }`; `prefix: ''` removes the default `Error:` / `Warning:` label entirely.                                                                                                                                                                                                                                  |
| `sliccy:color`                                | ANSI helpers: `green`, `red`, `yellow`, `gray`, `bold`, `cyan`, `dim`, plus `enabled` flag (auto-disabled on non-TTY / `NO_COLOR`).                                                                                                                                                                                                                                                                                        |
| `sliccy:time`                                 | `parseDuration(spec)`, `ago(spec)`, `range(spec)`, `future(spec)`, `gmailDate(spec)`. Units: `ms s m h d w M y` (note: `m` = minutes, `M` = months).                                                                                                                                                                                                                                                                       |
| `sliccy:fmt`                                  | `trunc(s, n)`, `col(s, width)`, `table(rows, widths?)`, `date(value, style?)`. `style`: `'short' \| 'iso' \| 'human' \| 'locale'` (locale = `Intl.DateTimeFormat` medium).                                                                                                                                                                                                                                                 |
| `sliccy:pool`                                 | `pool(n, items, fn)` — bounded concurrency runner, results returned in input order.                                                                                                                                                                                                                                                                                                                                        |

`require('sliccy:<unknown>')` throws a scheme-specific error (`Unknown sliccy: module '<name>'`); empty `require('sliccy:')` throws `empty sliccy: module name`. `sliccy:` lookups never hit the registry / `node_modules` / `ipk install`.

### Filesystem (VFS bridge)

`require('fs')` and `require('node:fs')` return the VFS bridge (`readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile(url, path)`). All paths are VFS-resolved, all async. There is no bare `fs` global.

### Examples for the non-trivial globals

```javascript
// process.argv.parseFlags() — replace per-skill arg loops
const { positional, flags, subcommand, passthrough } = process.argv.parseFlags();
// e.g. `mycli send --to alice --json -- --raw` →
//   positional: ['send', 'alice'], flags: { to: 'alice', json: true },
//   subcommand: 'send', passthrough: ['--raw']
```

**Two-level routing**: `parseFlags` populates `subcommand` only from the first positional. For `<cmd> <sub> [args]` CLIs, route the second level manually from `positional[1]`:

```javascript
const { positional, flags } = process.argv.parseFlags();
const [cmd, sub] = positional;
switch (cmd) {
  case 'pr':
    if (sub === 'list') return prList(flags);
    if (sub === 'view') return prView(positional[2], flags);
    return cli.die(`unknown pr subcommand: ${sub}`);
  // …
}
```

```javascript
// cli + color — early-exit helpers and color (both via sliccy:)
const cli = require('sliccy:cli');
const c = require('sliccy:color');
if (!flags.to) cli.die('--to is required'); // writes "Error: …" to stderr, exits 1
cli.out({ ok: true }); // pretty-prints JSON to stdout with trailing newline
console.log(c.green('✓'), c.dim('done'));
```

```javascript
// domain-specific prefix instead of the default "Error:"
const cli = require('sliccy:cli');
if (!flags.repo) cli.die('--repo is required', { prefix: 'gh' });
// → "gh: --repo is required"
cli.warn('rate limit at 80%', { prefix: 'gh' });
```

```javascript
// time — duration math
const time = require('sliccy:time');
const since = time.ago('7d'); // Date 7 days ago
const q = `after:${time.gmailDate('7d')}`; // "after:2026/05/22"

// fmt — ANSI-aware table
const fmt = require('sliccy:fmt');
const c = require('sliccy:color');
console.log(
  fmt.table([
    ['name', 'status'],
    ['hub', c.green('up')],
    ['relay', c.red('down')],
  ])
);

// pool — bounded concurrency
const pool = require('sliccy:pool');
const results = await pool(4, urls, async (url) => (await fetch(url)).status);
```

```javascript
// exec.spawn(argv[]) — bypass shell parsing. Use for any arg derived from
// untrusted input: it can't be shell-interpolated.
const { exec } = require('sliccy:exec');
const userMessage = flags.message ?? 'wip';
await exec.spawn(['git', 'commit', '-m', userMessage]); // safe even with quotes/spaces in userMessage
```

```javascript
// exec.start(cmdOrArgv, opts?) — killable, buffered-stdin spawn handle. Buffer
// stdin with .write(), launch with .end(), await .done for the result, and
// .kill(signal?) to abort. NOT interactive/streaming — just-bash is one-shot
// buffered, so stdin is a single upfront buffer and post-launch writes drop.
const { exec } = require('sliccy:exec');
const h = exec.start(['jq', '.name']);
h.stdin.write('{"name":"slicc"}');
h.stdin.end();
const { stdout, exitCode } = await h.done;
// h.kill('SIGTERM') fans a signal out via the exec:kill op.
```

```javascript
// agent — spawn a one-shot sub-scoop and block on its result. The callable
// resolves to the sub-scoop's final text; with `schema` it resolves to the
// parsed object (rejects if the reply wasn't valid JSON) and rejects on a
// non-zero exit. Use agent.spawn(...) when you want the raw outcome instead.
const agent = require('sliccy:agent');
const summary = await agent('Summarize /workspace/README.md in one line', {
  thinking: 'low',
  readOnly: '/workspace/',
});

const parsed = await agent('Extract the title as {"title": string}', {
  schema: { type: 'object', properties: { title: { type: 'string' } } },
});

const { finalText, exitCode, stderr } = await agent.spawn('do the thing', {
  model: 'claude-opus-4-6',
  cwd: '/tmp',
  allowedCommands: 'git,node',
});
```

### `require('child_process')` — Node process API over the exec bridge

`require('child_process')` / `require('node:child_process')` resolves in the `.jsh` / `node` realm to a shim built on `exec.start`. `exec` / `execFile` / `spawn` map onto the one-shot just-bash exec pipeline: the returned `ChildProcess` is an `EventEmitter` that fires `'exit'` / `'close'`, and its `.stdout` / `.stderr` are Readable stubs that each emit a single `'data'` chunk then `'end'`. `exec` / `execFile` also carry a `util.promisify.custom` implementation resolving `{ stdout, stderr }`.

```javascript
const { exec } = require('child_process');
const { promisify } = require('util');
const { stdout } = await promisify(exec)('ls -la /workspace');
```

The **sync forms** (`execSync` / `spawnSync` / `execFileSync`) and `fork` throw — just-bash has no synchronous or long-lived process model. `.bsh` scripts (which run in the target page via CDP, not the realm) have no shell bridge at all, so `require('child_process')` there is unavailable; use `exec()` from a `.jsh` script instead.

## jsh runtime extensions

The following capabilities collapse the boilerplate that 18 of 23 surveyed skills reinvented. They're available in both standalone and extension floats; each is reached through `require('sliccy:<name>')` (or the equivalent ESM `import`).

### `sliccy:skill` — script-relative paths, config, tokens

Computed once at boot from `argv[1]` and frozen. Replaces ad-hoc `process.argv[1].substring(0, …)` dirname math, bespoke `.config` JSON readers, and `oauth-token` shell-outs.

```typescript
const skill = require('sliccy:skill');
skill.dir: string                                              // directory containing the running script
skill.refs: string                                             // `<dir>/references`
skill.assets: string                                           // `<dir>/assets`
skill.config(): Promise<Record<string, unknown> | null>        // read parsed JSON from `<dir>/.config`
skill.config(updates): Promise<Record<string, unknown>>        // shallow-merge + write, returns merged
skill.token(providerId: string): Promise<string>               // shells out to `oauth-token <id>`
```

```javascript
const skill = require('sliccy:skill');
const fs = require('fs');
const cfg = (await skill.config()) ?? {};
const token = await skill.token('adobe');
const tmpl = await fs.readFile(`${skill.refs}/prompt.md`);
```

### `sliccy:browser` — page-context CDP bridge

Replaces the `exec('playwright-cli tab-list')` shell-out + regex parse used in ~12 skills. Accepts a `TabHandle` (from `findTab` / `ensureTab`) or a bare `targetId` string. `eval` / `evalAsync` serialize functions to a string call expression so realm code can pass a closure as ergonomically as a string.

```typescript
const browser = require('sliccy:browser');
browser.findTab(opts: { domain?: string; urlMatch?: RegExp | string }): Promise<TabHandle | null>
browser.ensureTab(url: string, opts?: { matchUrl?: RegExp | string }): Promise<TabHandle>
browser.eval(tab, fn: Function | string): Promise<unknown>      // sync expression
browser.evalAsync(tab, fn: AsyncFunction): Promise<unknown>     // async, returns parsed JSON
browser.cookie(tab, name: string): Promise<string | null>
browser.localStorage(tab, key: string): Promise<string | null>
```

```javascript
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
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
const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
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

**Discovery requires outbound `send()`.** The router patches `WebSocket.prototype.send` as a pure discovery hook — it never observes outbound frames, but a WebSocket instance is only wrapped (and its inbound `message` listener attached) the first time something calls `send()` on it. Receive-only sockets that never call `send()` are not currently captured; trigger a no-op send from the page (or wait for the page to send a heartbeat / subscription frame) before subscribing.

Skills cannot supply an arbitrary URL, cannot supply page-context code (the `filter` selector is a declarative JSON object — `parseAs`, `where`, `project` — and the realm rejects functions or strings of JS at the boundary), and cannot intercept outbound `send` traffic. Subscribers owned by a scoop auto-close when the scoop is dropped.

### `sliccy:http` — standard API-client builder

`require('sliccy:http')` exposes `http.client({ baseUrl, token, headers, retry, timeoutMs })`. Standardizes the `build URL → merge headers → resolve auth → fetch → unwrap JSON → throw on !ok` boilerplate. `token` is **lazy** — resolved freshly per request so token rotation / refresh hooks are picked up without recreating the client. Backoff is exponential, but **`Retry-After` (when present and parseable, in seconds or HTTP date) takes precedence** — the server knows its own rate limit.

```typescript
const http = require('sliccy:http');
http.client(config: {
  baseUrl?: string;
  token?: (req?: { method: string; path: string; url: string }) => string | Promise<string | null | undefined>;
  headers?: Record<string, string>;
  retry?: { on: number[]; maxAttempts: number };  // maxAttempts is total (including first)
  timeoutMs?: number;                              // per-attempt timeout; aborts the fetch
}): {
  get(path, opts?):    Promise<unknown>;
  post(path, opts?):   Promise<unknown>;
  put(path, opts?):    Promise<unknown>;
  patch(path, opts?):  Promise<unknown>;
  delete(path, opts?): Promise<unknown>;
}
// opts: { params?, headers?, body?, signal?: AbortSignal, raw?: boolean }
//  - body object → JSON, params → querystring
//  - signal: caller-owned abort signal (timeoutMs creates its own per-attempt signal that combines with this)
//  - raw: when true, returns { body, headers, status } instead of just body — needed for pagination (Link header) and rate-limit (X-RateLimit-*) instrumentation
```

```javascript
const http = require('sliccy:http');
const skill = require('sliccy:skill');
const api = http.client({
  baseUrl: 'https://graph.microsoft.com/v1.0',
  token: () => skill.token('microsoft'),
  headers: { Accept: 'application/json' },
  retry: { on: [429, 503], maxAttempts: 4 },
});

const me = await api.get('/me');
const sent = await api.post('/me/sendMail', {
  body: {
    message: {/* … */},
  },
});
// Non-2xx throws `HttpError` with { status, statusText, url, body }.
```

```javascript
// raw responses for pagination
const resp = await api.get('/users', { raw: true });
const link = resp.headers['link']; // e.g. '<…/users?page=2>; rel="next"'

// per-request abort
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 5000);
await api.get('/slow', { signal: ctl.signal });

// token with request context (e.g. different token for reads vs writes)
const api = http.client({
  baseUrl: 'https://api.example.com',
  token: (req) => (req?.method === 'GET' ? skill.token('read') : skill.token('write')),
});
```

### `sliccy:hid` / `sliccy:serial` / `sliccy:usb` — native device scripting

`require('sliccy:hid')` / `require('sliccy:serial')` / `require('sliccy:usb')` expose the WebHID / Web Serial / WebUSB bridges. The top-level entry points are `hid.list()` / `hid.request(filters?)` (and parity `serial.*` / `usb.*`); each device returned carries its opaque handle and methods that round-trip via panel-RPC. The handle namespace is shared with the `hid` / `serial` / `usb` shell commands — a port from `serial request` is reachable as `(await serial.list()).find(p => p.handle === 'serial1')`. Chromium-only; unavailable in the cloud / hosted-leader float. `hid.request()` still needs a user gesture (same as the shell `hid request`).

HID devices expose an `EventTarget`-shaped surface so a VIA-style **request/response in one script** doesn't race: subscribe `'inputreport'` first, then `sendReport`, await the callback. The first listener lazily subscribes the kernel-side relay; the last `removeEventListener` (or realm teardown) unsubscribes — no leaked page-side listeners.

```typescript
const hid = require('sliccy:hid');
hid.list(): Promise<HidDevice[]>
hid.request(filters?: HidDeviceFilter | HidDeviceFilter[]): Promise<HidDevice>

// On each HidDevice (carries `handle`, `vendorId`, `productId`, `productName`, `collections`):
device.open(): Promise<void>
device.close(): Promise<void>
device.sendReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>
device.sendFeatureReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>
device.receiveFeatureReport(reportId: number): Promise<DataView>
device.addEventListener('inputreport', cb): void   // event: { reportId, data: DataView }
device.removeEventListener('inputreport', cb): void
device.addEventListener('disconnect', cb): void    // registers; no backend emit yet
device.onInputReport(cb): void                     // alias for addEventListener('inputreport', cb)
```

```javascript
// VIA-style protocol-version round-trip as a single .jsh script.
// Subscribe BEFORE sendReport so the reply can't beat the listener.
const hid = require('sliccy:hid');
const [device] = await hid.list();
await device.open();
const reply = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 1000);
  device.addEventListener('inputreport', function once(e) {
    clearTimeout(t);
    device.removeEventListener('inputreport', once);
    resolve(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
  });
});
await device.sendReport(0, new Uint8Array([0x01]));
const bytes = await reply;
console.log([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '));
```

`serial.*` and `usb.*` mirror the shell surface (`open` / `close` / `read` / `write` / `getSignals` / `setSignals` on serial ports; `open` / `close` / `claim` / `release` / `controlIn` / `controlOut` / `transferIn` / `transferOut` on usb devices). They don't carry the `EventTarget` shape — those transports are explicit-poll.

For ESP32 / ESP8266 work, drive `esptool` through `require('sliccy:exec')` (there is no bare `exec` global). Beyond the existing `chip_id` / `read_mac` / `erase_flash` / `write_flash` verbs, the read/inspect set is now `flash_id`, `read_reg <addr>`, `read_flash <addr> <size> <outfile>`, `erase_region <addr> <size>`, and `run`. Pass `--port <handle>` to reuse a port from `serial request` so no second picker fires:

```javascript
const serial = require('sliccy:serial');
const { exec } = require('sliccy:exec');
const port = (await serial.list())[0] ?? (await serial.request());
const { stdout } = await exec(`esptool --port ${port.handle} flash_id`);
console.log(stdout);
await exec.spawn([
  'esptool',
  '--port',
  port.handle,
  'read_flash',
  '0',
  '0x1000',
  '/tmp/header.bin',
]);
```

## Reaching these from sprinkles & dips

The high-value capabilities here — `exec` / `exec.spawn`, `fetch`, `http.client`, `browser.*`, and the device APIs (`hid.*` / `serial.*` / `usb.*`) — are also exposed to `.shtml` **sprinkles** and **trusted dips** through the `slicc.*` bridge, which routes each call into the **same worker shell** `.jsh` scripts run in. So a sprinkle button can `await slicc.exec('…')` to reach any supplemental command or `.jsh` script, `await slicc.agent('…')` to spawn a one-shot sub-scoop, or `slicc.hid.on('inputreport', cb)` + `slicc.hid.sendReport(handle, reportId, bytes)` to drive a VIA-style keyboard from a UI panel (handles persist across button clicks). The bridge is trust-gated: VFS-sourced sprinkles and trusted dips get it; untrusted inline-chat dips never receive `exec` / `agent` / `browser` / device globals. See the sprinkles skill (`/workspace/skills/sprinkles/SKILL.md`) "Shell, agent, and jsh globals" section, and `docs/shell-reference.md` "Sprinkle & Dip Bridge" (developer-facing).
