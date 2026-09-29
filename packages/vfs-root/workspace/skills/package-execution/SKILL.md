---
name: package-execution
description: |
  Use this when the user asks to run or install a JavaScript/npm package with
  `npx` or `ipx`, or to run a `package.json` script with `npm run`. Covers
  built-in hints, any required `ipk add` bootstrap, the `--force` bypass, and
  how script bodies resolve installed bins.
allowed-tools: bash
---

# JavaScript package execution

`ipx` / `npx` — run bins from nearest `node_modules`; else install + run. Mapped names matching SLICC built-ins exit non-zero with stderr hint (built-in name + optional `ipk add` bootstrap). Prefer built-in. Override:

```bash
npx --force <package> [args...]
ipx --force <package> [args...]
```

Installed packages and unmapped names behave normally. Discover built-ins via `commands`.

## Install / remove

`ipk install` / `npm install` / `npm i` / `ipk add` → `<cwd>/node_modules` + nearest `package.json` (existing section or `dependencies`). `-D` / `--save-dev` → `devDependencies`. Bare declared name resolves existing range (not latest). Range resolution prefers `latest` when it satisfies (`*` → `latest`); skip deprecated unless nothing else fits. Unknown flags fail. No-args install covers `dependencies` + `devDependencies` + `optionalDependencies` without rewriting `package.json`. `-g` → `/shared/lib/node_modules`, manifest `/shared/lib/package.json`, PATH bins `/shared/bin/*.jsh`.

Tarball integrity checked before extract — `EINTEGRITY` means that package was not extracted (earlier packages may already be on disk; `package.json` unchanged). Check `ipk list`, retry. Modes: 0755 if tarball-executable else 0644; `bin` targets always executable (older trees repaired on next install). Optional deps skipped unless `cpu: wasm32`; for napi-rs without a wasm binding, add `<pkg>-wasm32-wasi` yourself.

```bash
ipk install lodash
ipk install -D eslint
npm install --save-dev eslint@8.57.1
ipk install -g typescript
npm uninstall -g typescript
npm list -g && npm root -g
```

Global bins: `/shared/bin/<name>.jsh` → `ipx --global <bin>` (local doesn't shadow).

## Wasm (`wasm`)

`ipk add -g @ai-ecoverse/wasm-<tool>` (or `slicc.commands` / `bin/<x>`+`.wasm`; `"abi":"wasi"` = Zig/Go/Rust, no glue) → run by name. `wasm --list`; `which <name>`. Built-in wins → `wasm <name> ARGS`. `wasm -t <name>` — panel TTY (`wasm -t bash`: job control). File: `wasm ./tool.wasm ARGS` (or `./tool.wasm` in GNU bash). WASIX: fork/exec/pipes; threads (`wasm32-wasip1-threads`) ≤64 workers (`SLICC_WASM_THREADS=N`). Server: `wasm --listen PORT ./server.wasm` (`$SLICC_LISTEN_FDS`). `@ai-ecoverse/wasm-bash` moves agent `bash` + panel (`wasm --login`) to GNU bash (`cd`/exports persist; functions don't). `export SLICC_SHELL=just-bash` reverts.

Sockets: `127.0.0.1:PORT` between wasm programs (panel/scoop networks separate). Outbound HTTP via `http_proxy`/`https_proxy` → `127.0.0.1:3128` (`no_proxy` keeps localhost). HTTPS: proxy TLS with realm CA (`SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `GIT_SSL_CAINFO` → `$HOME/.config/slicc/realm-ca-*.pem`; no `-k`). Redirects as normal (`curl -L`); Sliccstart follows itself. Only `localhost`/`127.0.0.1` resolve.

Once a Go toolchain package is installed, `go build` / `go run` build here (`go` is SLICC's driver; output is wasip1 run as `./prog`, or any `GOOS`/`GOARCH` whose stdlib is installed; stdlib + module packages only — no cgo, `//go:embed`, or module downloads yet). Native `python3` (once installed) in GNU bash; `pyodide` stays Pyodide. `@ai-ecoverse/wasm-git`: `git` in GNU bash is native (just-bash keeps built-in; `wasm git` for native). Auth via `git-credential-slicc` (GitHub login / `$GH_TOKEN` / `$GITHUB_TOKEN` / host-scoped `*_TOKEN`); don't put tokens in URLs. `~/.gitconfig` overrides; `$HOME/.config/slicc/gitconfig` is realm system config.

## Conda (`ipk mamba`)

`ipk mamba install <pkg>[=<version>]` → `/shared/lib/conda` (emscripten-forge). Keeps executable bits. For forge C/WASM libs (`zlib`, `libpng`). **Not** replacements for npm built-ins:

- `convert` → `ipk add -g @imagemagick/magick-wasm@…`
- `ffmpeg` → `ipk add -g @ffmpeg/core@…`
- `python` → `ipk add pyodide@…`

```bash
ipk mamba install zlib
ipk mamba install zlib=1.3.1
ipk mamba list && ipk mamba uninstall zlib && ipk mamba --help
```

## `package.json` scripts

`npm run` / `ipk run` / shortcuts (`npm test`, `start`, `stop`, `restart`):

```bash
npm run
npm run build
npm run build -- --watch
npm run build --silent
npm run lint -- --help
```

`--silent`/`-s`, `--if-present` before `--`; rest goes to script. Missing `start` → `node server.js`; missing `restart` → `npm stop --if-present && npm start`.

Bare bin in script body → `ipx <bin>` when installed (`$PATH` lacks `node_modules/.bin`). Built-in wins; unknown word not auto-installed — `ipk add <pkg>` first.
