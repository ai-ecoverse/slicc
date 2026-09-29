# jsh runtime extensions

Bundled at `/workspace/skills/skill-authoring/jsh-runtime-extensions.md`. Developer equivalent: `docs/shell-reference.md`. Keep in sync.

## Globals API

`.jsh` runs in async wrapper. Capability bridges via `require('sliccy:<name>')` — not bare globals.

### Node-standard globals

| Global                                                     | Purpose                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process`                                                  | `argv` + `.parseFlags()`, `env`, `cwd()`, `exit(code)`, `exitCode` (deferred — honoured after event-loop drain), `stdout.write`, `stderr.write`. `stdin` fully-buffered one-shot: `read()` (null if nothing piped), events (`on('data')`→`'end'`→`'close'`, single chunk; `pause()`/`resume()`), async iterator — drain via exactly one |
| `console`                                                  | `log`/`info`/`debug`/`table`/`dir` → stdout; `warn`/`error`/`assert`/`trace` → stderr                                                                                                                                                                                                                                                   |
| `fetch`                                                    | Proxied transport (cookies, CORS, secret masking). Binary bodies (`Uint8Array`/`Blob`/`FormData`) sent as raw bytes. `await res.json()`/`.text()` from buffered body keeps realm alive. Stream I/O (`Request`/`Response` body reads, `ReadableStream` `read`/`pipeTo`) also keeps realm alive                                           |
| `require(p)`                                               | CJS. `sliccy:<name>`, `fs`/`node:fs`, installed packages                                                                                                                                                                                                                                                                                |
| `Buffer` / `globalThis`                                    | Node-standard                                                                                                                                                                                                                                                                                                                           |
| `setTimeout`/`clearTimeout`/`setInterval`/`queueMicrotask` | Timers keep realm alive; `process.exit()` cancels                                                                                                                                                                                                                                                                                       |
| `__dirname` / `__filename`                                 | Script path                                                                                                                                                                                                                                                                                                                             |
| `module` / `exports`                                       | CJS record                                                                                                                                                                                                                                                                                                                              |

`process.argv.parseFlags()` → `{ positional, flags, subcommand, passthrough }`. Two-level CLIs: `subcommand` = first positional only; route `positional[1]` manually for `<cmd> <sub>`.

```javascript
const { positional, flags, subcommand, passthrough } = process.argv.parseFlags();
// `mycli send --to alice --json -- --raw` →
//   positional: ['send','alice'], flags: { to:'alice', json:true },
//   subcommand: 'send', passthrough: ['--raw']
```

### `sliccy:` modules

| Module                      | API                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sliccy:exec`               | `exec(cmd)` → `{stdout, stderr, exitCode}`. `.spawn(argv[])`, `.start(cmdOrArgv, opts?)` (killable handle)                                                                               |
| `sliccy:agent`              | `agent(prompt, opts?)` — resolves final text (JSON if `schema`). `.spawn` → `{finalText, exitCode, stderr}`. `opts`: `model`, `thinking`, `cwd`, `allowedCommands`, `readOnly`, `schema` |
| `sliccy:skill`              | `{ dir, root, refs, assets, config(), config(updates), token(providerId) }`. `root` = parent of `scripts/` segment                                                                       |
| `sliccy:http`               | `http.client({ baseUrl, token, headers, retry, timeoutMs })` → `get`/`post`/`put`/`patch`/`delete`                                                                                       |
| `sliccy:browser`            | `findTab`, `ensureTab`, `openWindow`, `windowBounds`, `setWindowBounds`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`, `websocket.on(...)`                                     |
| `sliccy:usb`/`serial`/`hid` | `list()`/`request()` + device methods (Chromium-only)                                                                                                                                    |
| `sliccy:computer`           | `register(handlers)` — screenshot/input over `computer-call`                                                                                                                             |
| `sliccy:cli`                | `die(msg, opts?)`, `out(value)`, `warn(msg, opts?)`, `help(text)`. `opts.prefix` overrides label                                                                                         |
| `sliccy:color`              | `green`, `red`, `yellow`, `gray`, `bold`, `cyan`, `dim`, `enabled`                                                                                                                       |
| `sliccy:time`               | `parseDuration`, `ago`, `range`, `future`, `gmailDate`. `m`=minutes, `M`=months                                                                                                          |
| `sliccy:fmt`                | `trunc`, `col`, `table`, `date(value, style?)`                                                                                                                                           |
| `sliccy:pool`               | `pool(n, items, fn)` — bounded concurrency, input order                                                                                                                                  |

`require('sliccy:<unknown>')` throws. Empty `sliccy:` throws.

### VFS (`require('fs')`)

`readFile`, `writeFile`, `readFileBinary`, `writeFileBinary`, `appendFile`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile(url, path)` + sync set (`readFileSync`, `writeFileSync`, `appendFileSync`, `existsSync`, `statSync`, …). All paths VFS-resolved. No bare `fs` global.

Async `appendFile` is one locked VFS RPC — concurrent appends to same path keep every payload. `writeFileSync`/`appendFileSync` persist at call time; `console.log` captured as printed — `timeout`/`kill` of node realm (rc=124/137) still leaves log file and stdout written before hang.

Stdio fds: `fs.readFileSync(0,'utf8')` or `/dev/stdin` reads piped stdin without consuming `process.stdin`; `writeFileSync(1,…)`/`writeFileSync(2,…)` or `/dev/stdout`/`/dev/stderr`. `existsSync`/`statSync` report stream devices present. Unknown numeric fds / wrong-direction ops throw `EBADF`.

### Examples for non-trivial globals

```javascript
const cli = require('sliccy:cli');
const c = require('sliccy:color');
if (!flags.to) cli.die('--to is required');
cli.out({ ok: true });
console.log(c.green('✓'), c.dim('done'));
if (!flags.repo) cli.die('--repo is required', { prefix: 'gh' }); // → "gh: --repo is required"
```

```javascript
const time = require('sliccy:time');
const fmt = require('sliccy:fmt');
const since = time.ago('7d');
const q = `after:${time.gmailDate('7d')}`;
console.log(
  fmt.table([
    ['name', 'status'],
    ['hub', c.green('up')],
  ])
);
const results = await require('sliccy:pool')(4, urls, async (u) => (await fetch(u)).status);
```

```javascript
const { exec } = require('sliccy:exec');
await exec.spawn(['git', 'commit', '-m', userMessage]); // safe for untrusted args
const h = exec.start(['jq', '.name']);
h.stdin.write('{"name":"slicc"}');
h.stdin.end();
const { stdout, exitCode } = await h.done; // h.kill('SIGTERM') to abort
```

```javascript
const agent = require('sliccy:agent');
const summary = await agent('Summarize /workspace/README.md in one line', {
  thinking: 'low',
  readOnly: '/workspace/',
});
const parsed = await agent('Extract title as {"title":string}', {
  schema: { type: 'object', properties: { title: { type: 'string' } } },
});
const { finalText, exitCode, stderr } = await agent.spawn('do the thing', {
  model: 'claude-opus-4-6',
  cwd: process.env.TMPDIR ?? '/tmp',
  allowedCommands: 'git,node',
});
```

### `readline`

`require('readline')` / `require('readline/promises')` over buffered stdin:

```javascript
const readline = require('readline/promises');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for await (const line of rl) console.log('>', line);
// or: rl.on('line', fn) … rl.on('close', fn), or const answer = await rl.question('name? ')
```

Creating the interface drains `process.stdin` (one-shot). `question()` returns next unconsumed line (`''` at EOF).

### `child_process`

`require('child_process')` / `require('node:child_process')` — shim over `exec.start`. `exec`/`execFile`/`spawn` → `ChildProcess` (`'exit'`/`'close'`; stdout/stderr emit single `'data'` chunk). `promisify(exec)` → `{ stdout, stderr }`.

Sync forms (`execSync`/`spawnSync`/`execFileSync`) on blocking sync-XHR bridge; `{ cwd }` sets child cwd; `{ env }` **replaces** child env (spread `process.env` to extend). Missing `cwd` → `ENOENT`. Need controlling Service Worker; without one throws naming async escape hatch. `fork` always throws. `.bsh` (page via CDP) has no shell bridge — use `.jsh`.

## Module details

### `sliccy:skill`

Computed once at boot from `argv[1]`, frozen. Layout: `<skill-root>/{SKILL.md,scripts/,references/,assets/}`. When script path contains `scripts/` segment, `skill.root` = parent of that segment; else `skill.root` = `skill.dir`. `config()` reads/writes `<dir>/.config` (typically `scripts/.config`).

```typescript
skill.dir: string
skill.root: string
skill.refs: string       // <root>/references
skill.assets: string     // <root>/assets
skill.config(): Promise<Record<string, unknown> | null>
skill.config(updates): Promise<Record<string, unknown>>  // shallow-merge + write
skill.token(providerId): Promise<string>                 // shells out oauth-token
```

```javascript
const skill = require('sliccy:skill');
const cfg = (await skill.config()) ?? {};
const token = await skill.token('adobe');
const tmpl = await require('fs').readFile(`${skill.refs}/prompt.md`);
```

### `sliccy:browser`

```typescript
browser.findTab({ domain?, urlMatch? }): Promise<TabHandle | null>
browser.ensureTab(url, { matchUrl? }): Promise<TabHandle>
browser.openWindow(url, { width?, height?, left?, top?, state?, decorated?, focus? }): Promise<TabHandle>
browser.windowBounds(tab): Promise<{ left, top, width, height, state, dpr }>
browser.setWindowBounds(tab, bounds): Promise<achieved bounds>
browser.eval(tab, fn | string): Promise<unknown>
browser.evalAsync(tab, fn): Promise<unknown>
browser.cookie(tab, name) / browser.localStorage(tab, key)
```

**Window sizing = frame DIP** (includes title bar), matching CDP `Target.createTarget` / `Browser.Bounds` — NOT `window.open` content area (will be short by chrome height). `state` other than `normal` cannot combine with left/top/width/height. `setWindowBounds` returns achieved bounds (Chrome clamps silently).

Standalone (Swift/Node CDP): `Target.createTarget({ newWindow:true, … })` + `Browser.get/setWindowBounds`. Extension: maps onto `chrome.windows.create/update/get`.

```javascript
const browser = require('sliccy:browser');
const tab = await browser.findTab({ domain: 'slack.com' });
if (!tab) require('sliccy:cli').die('open slack.com first');
const team = await browser.eval(tab, () => document.title);
const xoxc = await browser.localStorage(tab, 'localConfig_v2');
const cap = await browser.openWindow('https://example.com/demo', { width: 1280, height: 800 });
const { width, height, dpr } = await browser.windowBounds(cap);
```

### `browser.fetch(tab, url, opts?)`

Page-context fetch — cookies + same-origin automatic.

```typescript
{ method?, headers?, body?, credentials?: 'include'|'omit', responseType?: 'text'|'json'|'binary', timeoutMs? }
→ { ok, status, statusText, url, redirected, headers, body, bodyEncoding? }
```

From shell, `curlwright` is the same capability with curl flags — use while exploring; settle into `browser.fetch` in `.jsh`.

```javascript
const resp = await browser.fetch(tab, '/api/conversations.list', {
  method: 'POST',
  body: { limit: 100 },
});
if (!resp.ok) require('sliccy:cli').die(`slack ${resp.status}`);
const channels = resp.body.channels;
```

### `browser.websocket`

**Required for new WS-watch.** No prototype patches in skill code.

```typescript
const sub = await browser.websocket
  .on(tab, { urlMatch })
  .filter({ parseAs: 'json', where: { … }, project? })
  .forward({ sink: 'webhook'|'scoop'|'vfs'|'log', webhookId?, … });
await sub.update({ filter }) / sub.close() / browser.websocket.list()
```

**Sink set is closed enum** — page-side router only knows:

- `'webhook'` — resolved against webhook registry; unknown `webhookId` rejects at creation.
- `'scoop'` — orchestrator scoop dispatch.
- `'vfs'` — append to absolute path starting with `/workspace/`.
- `'log'` — telemetry only.

**Discovery requires outbound `send()`.** Router patches `WebSocket.prototype.send` as discovery hook — instance wrapped only after first `send()`. Receive-only sockets that never send aren't captured; trigger no-op send or wait for page heartbeat first.

Skills cannot supply arbitrary URLs, page-context code (filter is declarative JSON: `parseAs`, `where`, `project`), or intercept outbound send. Subscribers auto-close on scoop drop.

### `sliccy:http`

```typescript
http.client({ baseUrl?, token?, headers?, retry?: { on, maxAttempts, methods? }, timeoutMs? })
→ { get, post, put, patch, delete }
// opts per call: { params?, headers?, body?, signal?: AbortSignal, raw?: boolean }
```

- `token` lazy per request — resolved freshly so rotation hooks picked up without recreating client.
- `Retry-After` precedence over exponential backoff.
- Default retry methods: RFC 9110 idempotent set (`GET`/`HEAD`/`OPTIONS`/`TRACE`/`PUT`/`DELETE`); `429` retries any method; `503` on `POST` never silently replays.
- `opts.raw: true` → `{ body, headers, status }` for pagination (`Link` header) and rate-limit (`X-RateLimit-*`).
- `opts.signal: AbortSignal` combines with per-attempt `timeoutMs`.
- `token(req?)` lazy per request — `{ method, path, url }` context for read vs write tokens.
- Non-2xx throws `HttpError` with `{ status, statusText, url, body }`.

```javascript
const http = require('sliccy:http');
const skill = require('sliccy:skill');
const api = http.client({
  baseUrl: 'https://graph.microsoft.com/v1.0',
  token: () => skill.token('microsoft'),
  retry: { on: [429, 503], maxAttempts: 4 },
});
const me = await api.get('/me');
const resp = await api.get('/users', { raw: true });
const link = resp.headers['link'];
```

### `sliccy:hid` / `serial` / `usb`

Chromium-only. `list()` / `request(filters?)` (gesture required). Handles shared with shell commands.

**HID** — `EventTarget` shape. Subscribe `'inputreport'` BEFORE `sendReport` so reply can't beat listener. First listener lazily subscribes kernel relay; last `removeEventListener` unsubscribes.

```typescript
hid.list(): Promise<HidDevice[]>
hid.request(filters?): Promise<HidDevice[]>
device.open() / close()
device.sendReport(reportId, data) / sendFeatureReport / receiveFeatureReport
device.addEventListener('inputreport', cb)  // { reportId, data: DataView }
device.removeEventListener('inputreport', cb)
device.onInputReport(cb)  // alias
```

```javascript
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
console.log([...(await reply)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
```

**USB** — WebUSB method names, NOT shell verb aliases: `claimInterface(n)`, `controlTransferIn(setup, length)`, `transferIn(endpoint, length)`, `clearHalt('in'|'out', endpoint)`. Results `{ status, data: DataView }` — wrap to `Uint8Array`. Exclusive interface claims; second claim refused naming holder (or `{ wait: true }`). `close()`/`reset()` refuse while another holds claim unless `{ force: true }` → `claim-lost` then `disconnect`. Optional `configurations` descriptor tree (branch on presence; absent when platform doesn't expose).

**Serial** — `open`/`close`/`read`/`write`/`getSignals`/`setSignals`. No EventTarget — explicit poll.

**ESP32/ESP8266** — drive `esptool` via `sliccy:exec` (no bare `exec` global). `--port <handle>` from `serial request` avoids second picker. Verbs: `chip_id`, `read_mac`, `erase_flash`, `write_flash`, `flash_id`, `read_reg <addr>`, `read_flash <addr> <size> <outfile>`, `erase_region <addr> <size>`, `run`.

```javascript
const serial = require('sliccy:serial');
const { exec } = require('sliccy:exec');
const port = (await serial.list())[0] ?? (await serial.request());
const { stdout } = await exec(`esptool --port ${port.handle} flash_id`);
await exec.spawn([
  'esptool',
  '--port',
  port.handle,
  'read_flash',
  '0',
  '0x1000',
  `${process.env.TMPDIR ?? '/tmp'}/header.bin`,
]);
```

### `sliccy:computer`

```javascript
computer.register({
  id: 'jsh:fake', title, size, capabilities,
  screenshot(), input(events), subscribe?(fps, onFrame, maxWidth),
  text?, exec?, softKeys?,
});
```

`register()` subscribes to host `computer-call` events, keeping `jshd` alive (like HID inputreport listeners). Disposer unregisters. Ids typically `jsh:<name>`.

Handlers: required `id`, `capabilities`, `screenshot`, `input`; optional `title`, `size`, `softKeys`, `text`, `exec`, `subscribe(fps, onFrame, maxWidth)` (return unsubscribe). `input` receives mousemove/button/click/scroll/key/text/wait/drag events. Frames return via `computer.frame`.

Example: `/workspace/skills/jshd/examples/fake-computer.jsh` — 640×400 clock, click marker, soft keys, OffscreenCanvas JPEG or stored-deflate PNG. Real ADB `screenrecord` / `phone-view` consumer lives in skills repo, not this tree.

`require('sliccy:<unknown>')` throws `Unknown sliccy: module '<name>'`; empty `require('sliccy:')` throws `empty sliccy: module name`. `sliccy:` lookups never hit registry / `node_modules` / `ipk install`.

## jsh runtime extensions (summary)

These collapse boilerplate reinvented across skills. Available CLI + extension; each via `require('sliccy:<name>')`:

| Extension                                      | Replaces                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `process.argv.parseFlags()`                    | Per-skill `--flag=val` loops                                        |
| `sliccy:browser`                               | `playwright-cli tab-list` shell-outs + regex                        |
| `browser.fetch(tab, url)`                      | eval-file + double-JSON-unwrap for page fetch                       |
| `browser.websocket.on(…).filter(…).forward(…)` | `WebSocket.prototype` patches (**required** for WS-watch)           |
| `sliccy:http.client(…)`                        | Hand-rolled API clients                                             |
| `sliccy:skill`                                 | `argv[1]` dirname math, `.config` readers, `oauth-token` shell-outs |
| `sliccy:computer.register(…)`                  | Custom computer backends                                            |

## Sprinkles & dips

High-value capabilities — `exec`/`exec.spawn`, `fetch`, `http.client`, `browser.*`, `hid.*`/`serial.*`/`usb.*` — also on `slicc.*` bridge routing into the **same worker shell** `.jsh` runs in. Sprinkle button can `await slicc.exec('…')`, `await slicc.agent('…')`, or `slicc.hid.on('inputreport', cb)` + `slicc.hid.sendReport(handle, reportId, bytes)` for VIA-style keyboard (handles persist across clicks).

Trust-gated: VFS-sourced sprinkles + trusted dips get bridge; untrusted inline-chat dips never receive `exec`/`agent`/`browser`/device globals. Sprinkle code uses trust-gated `slicc.*`; does not call `require('sliccy:…')` directly.

See `/workspace/skills/sprinkles/SKILL.md` "Shell, agent, and jsh globals" and `docs/shell-reference.md` "Sprinkle & Dip Bridge".
