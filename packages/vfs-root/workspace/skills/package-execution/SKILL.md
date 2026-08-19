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
