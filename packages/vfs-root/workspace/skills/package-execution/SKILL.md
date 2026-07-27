---
name: package-execution
description: |
  Use this when the user asks to run or install a JavaScript/npm package with
  `npx` or `ipx`, or when either command redirects to a SLICC built-in. Covers
  built-in hints, any required `ipk add` bootstrap, and the `--force` bypass.
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
