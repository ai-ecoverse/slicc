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

`ipx` runs package bins from the nearest installed `node_modules`; `npx` is an alias with the same behavior. If no local bin or installed package resolves, it normally installs the requested package and runs its bin.

Before that network install, mapped package names that duplicate SLICC built-ins redirect to the built-in instead. The command exits non-zero and prints an actionable stderr hint naming the built-in and suggesting an invocation with the original arguments. The hint may also include an exact `ipk add` bootstrap; run that bootstrap first when present, then use the suggested built-in.

Prefer the built-in. To deliberately preserve install-and-run behavior for the npm package, put `--force` before its name:

```bash
npx --force <package> [args...]
ipx --force <package> [args...]
```

Already-installed packages, locally resolved bins, and unmapped package names keep their normal behavior. Use `commands` to discover available built-ins instead of maintaining a package mapping here.

## Installing and removing packages

`ipk install <pkg>` (also `npm install`, `npm i`, `ipk add`) installs into `<cwd>/node_modules` and records the package in the nearest `package.json` — in the section it already occupies, or in `dependencies` if it is new. `ipk install -D <pkg>` / `npm install --save-dev <pkg>` records new packages in `devDependencies`. A bare name that is already declared is resolved against that existing range, not latest. Versions are picked as pnpm picks them: a range takes the `latest` dist-tag whenever `latest` satisfies it (`*` always takes `latest`), and deprecated versions are passed over unless nothing else fits. Unknown install flags fail instead of being ignored. `ipk install` with no package names installs declared `dependencies` and `devDependencies` without rewriting `package.json`. `ipk install -g <pkg>` installs into the shared global prefix at `/shared/lib/node_modules`, records direct dependencies in `/shared/lib/package.json`, and publishes PATH-visible `.jsh` delegators under `/shared/bin` for package bins. Every downloaded tarball is checked against the registry's published hash before it is extracted. An `EINTEGRITY` error means that package's bytes did not match and it was not extracted, but packages installed before it may already be on disk and `package.json` was not updated. Check the state with `ipk list`, then retry the install; don't work around it.

```bash
ipk install lodash              # local project install
ipk install -D eslint           # record in devDependencies
npm install --save-dev eslint@8.57.1
ipk install -g typescript       # global install (shared prefix + PATH bin)
npm uninstall -g typescript     # remove from global manifest and reconcile tree
npm list -g                     # list direct global dependencies
npm root -g                     # print /shared/lib/node_modules
```

Global bins installed with `-g` are on the default `$PATH` via `/shared/bin/<name>.jsh` delegators — invoke them by bare name from any cwd (delegators run `ipx --global <bin>` so a same-named local package does not shadow the global install). Local uninstall/list/root work without `-g` against the cwd `package.json`.

## Wasm programs (`wasm`)

A global package that ships wasm-realm programs (a `slicc.commands` manifest in its `package.json`, or an `@ai-ecoverse/wasm-*` package with `bin/<x>` + `bin/<x>.wasm`) makes each program a command: `ipk add -g @ai-ecoverse/wasm-<tool>`, then run it by name. `wasm --list` lists them; `which <name>` shows the package. A built-in of the same name (`sed`, `grep`, `cat`, …) still wins, so run the program with `wasm <name> ARGS...`. `wasm -t <name>` runs it interactively on the panel terminal (a TTY: `wasm -t bash` is a real bash prompt, with job control — ^Z, `jobs`, `fg`, `bg`); the agent's own `bash` tool has no terminal to lend. Installing `@ai-ecoverse/wasm-bash` also moves your own `bash` tool onto GNU bash (real pipes, `trap`, `select`, arrays, bash's exact semantics; `cd` and exports carry between calls, shell functions do not). Supplemental commands work as before. The terminal panel then opens in GNU bash too (`wasm --login` starts it; `exit` returns to the slicc prompt, and `wasm --login` starts it again). `export SLICC_SHELL=just-bash` switches both back. Wasm programs built with socket support talk over a private loopback network: a server listening on `127.0.0.1:PORT` in one of your wasm programs is reachable from your other wasm programs while it runs (the terminal panel and each scoop have networks of their own), and a program reaches the outside over HTTP through your network's proxy: `http_proxy` / `https_proxy` point at `127.0.0.1:3128` by default (`no_proxy` keeps `localhost` direct), so `curl http://…` works the way the shell's `curl` does, masked secrets included. HTTPS works too: the proxy terminates TLS with a certificate from your network's own CA, which `SSL_CERT_FILE` / `CURL_CA_BUNDLE` / `GIT_SSL_CAINFO` point programs at (`$HOME/.config/slicc/realm-ca-*.pem`; `-k` is never needed). A redirect reaches the program as it would any HTTP client (`curl -L` follows it), except on Sliccstart, whose fetch path follows redirects itself. No other traffic leaves: only `localhost` / `127.0.0.1` resolve.

## Conda / emscripten-forge (`ipk mamba`)

`ipk mamba install <pkg>[=<version>]` installs emscripten-wasm32 packages from emscripten-forge / conda-forge into `/shared/lib/conda` (not `node_modules`). Prefer this for **forge C/WASM libraries** (for example `zlib`, `libpng`) that provide headers, `.a`, and SIDE_MODULE `.so` under that prefix.

Keep using `ipk install` / `ipk add -g` for the **npm** packages that power these built-ins — forge names are not drop-in replacements today:

- `convert` → `ipk add -g @imagemagick/magick-wasm@…` (forge `imagemagick` has no runnable `convert.wasm`)
- `ffmpeg` → `ipk add -g @ffmpeg/core@…` (forge `ffmpeg` is libav `.a` only)
- `python` → `ipk add pyodide@…` (no forge `pyodide`)

```bash
ipk mamba install zlib          # newest indexed build → /shared/lib/conda
ipk mamba install zlib=1.3.1    # exact version
ipk mamba list                  # conda-meta inventory
ipk mamba uninstall zlib
ipk mamba --help                # channels, prefix, and thin-installer limits
```

## Running package.json scripts

`npm run <script>` (also `ipk run`, `npm run-script`, and the `npm test` / `start` / `stop` / `restart` shortcuts) runs a `scripts` entry from the nearest `package.json`, in that package's directory. `npm run` with no script name lists what is available — read that list instead of guessing a script name.

```bash
npm run                      # list scripts
npm run build                # run build, with prebuild/postbuild around it
npm run build -- --watch     # pass extra args to the script body
npm run build --silent       # no banner, script output only (either side of the name)
npm run lint -- --help       # --help after -- goes to the script, not to npm
```

`--silent`/`-s` and `--if-present` are npm's own flags anywhere before `--`; everything after `--` reaches the script untouched. Missing `start` falls back to `node server.js` when the package has one, and missing `restart` to `npm stop --if-present && npm start`.

A bare bin word in a script body (`vitest run`) is rewritten to `ipx vitest run` when that package is installed, because `$PATH` does not cover `node_modules/.bin` shims. This also applies after keywords like `if`/`then`/`do`. A SLICC built-in with the same name wins, and an unknown word is not installed implicitly — install it with `ipk add <pkg>` first.
