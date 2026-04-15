# ESM Import Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `.jsh` and `node -e` scripts to use ESM `import` syntax for npm packages, Node built-ins, and local VFS files.

**Architecture:** Pre-scan source for `import` statements; if found, fork to a new ESM execution path that injects a dynamic import map (npm → esm.sh, built-ins → synthetic shim URLs), sets up `globalThis.__slicc_*` shims, and executes the entry file as a real ES module via `await import('/preview/...')`. The preview SW synthesizes shim module responses for `/__shims/*` paths. The existing CJS `require()` path is untouched.

**Tech Stack:** TypeScript, Vitest, Vite, preview service worker, Chrome extension sandbox

**Spec:** `docs/superpowers/specs/2026-04-15-esm-import-support-design.md`

---

### Task 1: Add `hasESMImports()` detector to shared.ts

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/shared.ts`
- Create: `packages/webapp/tests/shell/supplemental-commands/esm-detection.test.ts`

- [x] **Step 1: Write failing tests for ESM detection**

```ts
// packages/webapp/tests/shell/supplemental-commands/esm-detection.test.ts
import { describe, it, expect } from 'vitest';
import {
  hasESMImports,
  extractImportSpecifiers,
} from '../../../src/shell/supplemental-commands/shared.js';

describe('hasESMImports', () => {
  it('detects default import', () => {
    expect(hasESMImports(`import chalk from 'chalk';`)).toBe(true);
  });

  it('detects named import', () => {
    expect(hasESMImports(`import { readFile } from 'fs';`)).toBe(true);
  });

  it('detects namespace import', () => {
    expect(hasESMImports(`import * as path from 'path';`)).toBe(true);
  });

  it('detects side-effect import', () => {
    expect(hasESMImports(`import './setup.js';`)).toBe(true);
  });

  it('ignores dynamic import expressions', () => {
    expect(hasESMImports(`const m = await import('chalk');`)).toBe(false);
  });

  it('ignores require calls', () => {
    expect(hasESMImports(`const chalk = require('chalk');`)).toBe(false);
  });

  it('ignores import inside string literals', () => {
    expect(hasESMImports(`const s = "import foo from 'bar'";`)).toBe(false);
  });

  it('ignores import inside comments', () => {
    expect(hasESMImports(`// import foo from 'bar'`)).toBe(false);
    expect(hasESMImports(`/* import foo from 'bar' */`)).toBe(false);
  });

  it('returns false for plain code', () => {
    expect(hasESMImports(`console.log('hello');`)).toBe(false);
  });
});

describe('extractImportSpecifiers', () => {
  it('extracts specifiers from multiple imports', () => {
    const code = `
import chalk from 'chalk';
import { readFile } from 'fs';
import './helpers.js';
import * as path from 'node:path';
`;
    const specifiers = extractImportSpecifiers(code);
    expect(specifiers).toContain('chalk');
    expect(specifiers).toContain('fs');
    expect(specifiers).toContain('./helpers.js');
    expect(specifiers).toContain('node:path');
  });

  it('deduplicates specifiers', () => {
    const code = `
import { a } from 'chalk';
import { b } from 'chalk';
`;
    expect(extractImportSpecifiers(code).filter((s) => s === 'chalk')).toHaveLength(1);
  });

  it('returns empty array for code with no imports', () => {
    expect(extractImportSpecifiers(`console.log('hello');`)).toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/webapp/tests/shell/supplemental-commands/esm-detection.test.ts`
Expected: FAIL — `hasESMImports` and `extractImportSpecifiers` do not exist.

- [x] **Step 3: Implement `hasESMImports` and `extractImportSpecifiers`**

Add to the end of `packages/webapp/src/shell/supplemental-commands/shared.ts`:

```ts
/**
 * Strip single-line (//) and multi-line (/* ... *​/) comments and string
 * literals from JavaScript source so that regex scanners don't match
 * specifiers that appear only inside comments or strings.
 */
function stripCommentsAndStrings(code: string): string {
  return code.replace(
    /\/\/.*$|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gm,
    (match) => {
      // Preserve string/template literals as whitespace-length placeholders
      // so that line positions don't shift; comments become spaces too.
      if (match.startsWith('/')) return ' '.repeat(match.length);
      return ' '.repeat(match.length);
    }
  );
}

/**
 * Detect whether source code contains static ESM import statements.
 * Ignores dynamic `import()` expressions, require() calls, and
 * imports inside comments or string literals.
 */
export function hasESMImports(code: string): boolean {
  const stripped = stripCommentsAndStrings(code);
  // Match: import <something> from '...'; or import '...';
  // But NOT: await import(...) or import(...)
  return /(?:^|\n|;)\s*import\s+(?:[\w*{}\s,]+from\s+)?['"]/.test(stripped);
}

/**
 * Extract the module specifier strings from static ESM import statements.
 * Returns deduplicated specifiers.
 */
export function extractImportSpecifiers(code: string): string[] {
  const stripped = stripCommentsAndStrings(code);
  const re = /(?:^|\n|;)\s*import\s+(?:[\w*{}\s,]+from\s+)?['"]([\w@/.\-:]+)['"]/g;
  const specifiers = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    specifiers.add(m[1]);
  }
  return [...specifiers];
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/webapp/tests/shell/supplemental-commands/esm-detection.test.ts`
Expected: PASS

- [x] **Step 5: Run Prettier and typecheck**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/shared.ts packages/webapp/tests/shell/supplemental-commands/esm-detection.test.ts
npm run typecheck
```

- [x] **Step 6: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/shared.ts packages/webapp/tests/shell/supplemental-commands/esm-detection.test.ts
git commit -m "feat(shell): add hasESMImports and extractImportSpecifiers detection utilities"
```

---

### Task 2: Add synthetic `/__shims/*` route to preview service worker

**Files:**

- Modify: `packages/webapp/src/ui/preview-sw.ts`
- Create: `packages/webapp/tests/ui/preview-sw-shims.test.ts`

- [x] **Step 1: Write failing tests for shim synthesis**

```ts
// packages/webapp/tests/ui/preview-sw-shims.test.ts
import { describe, it, expect } from 'vitest';
import {
  generateShimCode,
  SHIMMED_BUILTINS,
  UNAVAILABLE_BUILTINS,
} from '../../src/ui/preview-sw-shims.js';

describe('generateShimCode', () => {
  it('generates fs shim with named exports', () => {
    const code = generateShimCode('fs');
    expect(code).toContain('globalThis.__slicc_fs');
    expect(code).toContain('export const readFile');
    expect(code).toContain('export const writeFile');
    expect(code).toContain('export const readDir');
    expect(code).toContain('export const exists');
    expect(code).toContain('export const stat');
    expect(code).toContain('export const mkdir');
    expect(code).toContain('export const rm');
    expect(code).toContain('export const fetchToFile');
    expect(code).toContain('export default');
  });

  it('generates process shim with named exports', () => {
    const code = generateShimCode('process');
    expect(code).toContain('globalThis.__slicc_process');
    expect(code).toContain('export const argv');
    expect(code).toContain('export const env');
    expect(code).toContain('export const cwd');
    expect(code).toContain('export const exit');
    expect(code).toContain('export default');
  });

  it('generates buffer shim', () => {
    const code = generateShimCode('buffer');
    expect(code).toContain('Buffer');
    expect(code).toContain('export');
  });

  it('generates error shim for unavailable builtins', () => {
    const code = generateShimCode('http');
    expect(code).toContain('throw');
    expect(code).toContain('not available');
  });

  it('returns null for unknown modules', () => {
    expect(generateShimCode('unknown-thing')).toBeNull();
  });
});

describe('SHIMMED_BUILTINS', () => {
  it('contains fs, process, buffer', () => {
    expect(SHIMMED_BUILTINS).toContain('fs');
    expect(SHIMMED_BUILTINS).toContain('process');
    expect(SHIMMED_BUILTINS).toContain('buffer');
  });
});

describe('UNAVAILABLE_BUILTINS', () => {
  it('contains http, crypto, child_process', () => {
    expect(UNAVAILABLE_BUILTINS).toContain('http');
    expect(UNAVAILABLE_BUILTINS).toContain('crypto');
    expect(UNAVAILABLE_BUILTINS).toContain('child_process');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/webapp/tests/ui/preview-sw-shims.test.ts`
Expected: FAIL — module does not exist.

- [x] **Step 3: Create the shim generator module**

```ts
// packages/webapp/src/ui/preview-sw-shims.ts

export const SHIMMED_BUILTINS = ['fs', 'process', 'buffer'] as const;

export const UNAVAILABLE_BUILTINS = [
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'dns',
  'cluster',
  'worker_threads',
  'child_process',
  'crypto',
  'os',
  'stream',
  'zlib',
  'vm',
  'v8',
  'perf_hooks',
  'readline',
  'repl',
  'tty',
  'inspector',
] as const;

const HINTS: Record<string, string> = {
  http: 'Use fetch() instead.',
  https: 'Use fetch() instead.',
  child_process: 'Use exec() which is available as a shell bridge.',
  crypto: 'Use globalThis.crypto (Web Crypto API) instead.',
};

export function generateShimCode(name: string): string | null {
  switch (name) {
    case 'fs':
      return `
const shim = globalThis.__slicc_fs;
export const readFile = shim.readFile;
export const readFileBinary = shim.readFileBinary;
export const writeFile = shim.writeFile;
export const writeFileBinary = shim.writeFileBinary;
export const readDir = shim.readDir;
export const exists = shim.exists;
export const stat = shim.stat;
export const mkdir = shim.mkdir;
export const rm = shim.rm;
export const fetchToFile = shim.fetchToFile;
export default shim;
`;

    case 'process':
      return `
const shim = globalThis.__slicc_process;
export const argv = shim.argv;
export const env = shim.env;
export const cwd = shim.cwd;
export const exit = shim.exit;
export const stdout = shim.stdout;
export const stderr = shim.stderr;
export default shim;
`;

    case 'buffer':
      return `
export const Buffer = globalThis.Buffer;
export default { Buffer: globalThis.Buffer };
`;

    default: {
      if (UNAVAILABLE_BUILTINS.includes(name as (typeof UNAVAILABLE_BUILTINS)[number])) {
        const hint = HINTS[name] ? ' ' + HINTS[name] : '';
        return `throw new Error("Node built-in '${name}' is not available in the browser environment.${hint}");`;
      }
      return null;
    }
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/webapp/tests/ui/preview-sw-shims.test.ts`
Expected: PASS

- [x] **Step 5: Wire the shim route into preview-sw.ts**

In `packages/webapp/src/ui/preview-sw.ts`, add the shim handler in `handlePreviewRequest` before the LightningFS read. Add this block after `const isText = TEXT_TYPES.has(mimeType);` (line 127):

```ts
// Synthetic shim modules for ESM execution
if (vfsPath.startsWith('/__shims/')) {
  const shimName = vfsPath.slice('/__shims/'.length).replace(/\.m?js$/, '');
  const { generateShimCode } = await import('./preview-sw-shims.js');
  const code = generateShimCode(shimName);
  if (code) {
    return new Response(code, {
      status: 200,
      headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
    });
  }
}
```

Note: The preview SW is built as a separate IIFE entry point. The `import()` above is a dynamic import that Vite will bundle. If the build setup doesn't support this, inline `generateShimCode` directly in `preview-sw.ts` instead.

- [x] **Step 6: Run Prettier, typecheck, and full test suite**

```bash
npx prettier --write packages/webapp/src/ui/preview-sw.ts packages/webapp/src/ui/preview-sw-shims.ts packages/webapp/tests/ui/preview-sw-shims.test.ts
npm run typecheck
npm run test
```

- [x] **Step 7: Commit**

```bash
git add packages/webapp/src/ui/preview-sw-shims.ts packages/webapp/src/ui/preview-sw.ts packages/webapp/tests/ui/preview-sw-shims.test.ts
git commit -m "feat(preview-sw): add synthetic /__shims/* route for ESM built-in modules"
```

---

### Task 3: Build the import map from specifiers

**Files:**

- Create: `packages/webapp/src/shell/esm-import-map.ts`
- Create: `packages/webapp/tests/shell/esm-import-map.test.ts`

- [x] **Step 1: Write failing tests for import map building**

```ts
// packages/webapp/tests/shell/esm-import-map.test.ts
import { describe, it, expect } from 'vitest';
import { buildImportMap } from '../../src/shell/esm-import-map.js';

describe('buildImportMap', () => {
  it('maps Node built-ins to shim URLs', () => {
    const map = buildImportMap(['fs', 'process', 'buffer']);
    expect(map.imports['fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['node:fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['process']).toBe('/preview/__shims/process.js');
    expect(map.imports['node:process']).toBe('/preview/__shims/process.js');
    expect(map.imports['buffer']).toBe('/preview/__shims/buffer.js');
    expect(map.imports['node:buffer']).toBe('/preview/__shims/buffer.js');
  });

  it('maps unavailable builtins to error shim URLs', () => {
    const map = buildImportMap(['http', 'crypto']);
    expect(map.imports['http']).toBe('/preview/__shims/http.js');
    expect(map.imports['node:http']).toBe('/preview/__shims/http.js');
    expect(map.imports['crypto']).toBe('/preview/__shims/crypto.js');
  });

  it('maps npm packages to esm.sh', () => {
    const map = buildImportMap(['chalk', 'lodash']);
    expect(map.imports['chalk']).toBe('https://esm.sh/chalk');
    expect(map.imports['lodash']).toBe('https://esm.sh/lodash');
  });

  it('maps scoped npm packages to esm.sh', () => {
    const map = buildImportMap(['@adobe/aio-sdk']);
    expect(map.imports['@adobe/aio-sdk']).toBe('https://esm.sh/@adobe/aio-sdk');
  });

  it('maps path to esm.sh/path-browserify', () => {
    const map = buildImportMap(['path']);
    expect(map.imports['path']).toBe('https://esm.sh/path-browserify');
    expect(map.imports['node:path']).toBe('https://esm.sh/path-browserify');
  });

  it('skips relative specifiers', () => {
    const map = buildImportMap(['./helpers.js', '../utils.js', 'chalk']);
    expect(map.imports['./helpers.js']).toBeUndefined();
    expect(map.imports['../utils.js']).toBeUndefined();
    expect(map.imports['chalk']).toBe('https://esm.sh/chalk');
  });

  it('handles mixed specifiers', () => {
    const map = buildImportMap(['fs', 'chalk', './local.js', 'http']);
    expect(map.imports['fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['chalk']).toBe('https://esm.sh/chalk');
    expect(map.imports['./local.js']).toBeUndefined();
    expect(map.imports['http']).toBe('/preview/__shims/http.js');
  });

  it('returns empty imports for empty specifiers', () => {
    const map = buildImportMap([]);
    expect(Object.keys(map.imports)).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/webapp/tests/shell/esm-import-map.test.ts`
Expected: FAIL — module does not exist.

- [x] **Step 3: Implement `buildImportMap`**

```ts
// packages/webapp/src/shell/esm-import-map.ts

import { SHIMMED_BUILTINS, UNAVAILABLE_BUILTINS } from '../ui/preview-sw-shims.js';

interface ImportMap {
  imports: Record<string, string>;
}

const ALL_SHIMMED = new Set<string>([...SHIMMED_BUILTINS, ...UNAVAILABLE_BUILTINS]);

/** Builtins that have a better browser-compatible npm equivalent. */
const BUILTIN_NPM_ALIASES: Record<string, string> = {
  path: 'https://esm.sh/path-browserify',
};

/**
 * Build a browser import map from a list of bare import specifiers.
 * Relative specifiers (starting with . or /) are skipped — the browser
 * resolves those relative to the module URL automatically.
 */
export function buildImportMap(specifiers: string[]): ImportMap {
  const imports: Record<string, string> = {};

  for (const raw of specifiers) {
    if (raw.startsWith('.') || raw.startsWith('/')) continue;

    const bare = raw.startsWith('node:') ? raw.slice(5) : raw;

    if (BUILTIN_NPM_ALIASES[bare]) {
      const url = BUILTIN_NPM_ALIASES[bare];
      imports[bare] = url;
      imports[`node:${bare}`] = url;
      continue;
    }

    if (ALL_SHIMMED.has(bare)) {
      const shimUrl = `/preview/__shims/${bare}.js`;
      imports[bare] = shimUrl;
      imports[`node:${bare}`] = shimUrl;
      continue;
    }

    // npm package
    imports[raw] = `https://esm.sh/${raw}`;
  }

  return { imports };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/webapp/tests/shell/esm-import-map.test.ts`
Expected: PASS

- [x] **Step 5: Run Prettier and typecheck**

```bash
npx prettier --write packages/webapp/src/shell/esm-import-map.ts packages/webapp/tests/shell/esm-import-map.test.ts
npm run typecheck
```

- [x] **Step 6: Commit**

```bash
git add packages/webapp/src/shell/esm-import-map.ts packages/webapp/tests/shell/esm-import-map.test.ts
git commit -m "feat(shell): add buildImportMap for ESM specifier resolution"
```

---

### Task 4: Implement ESM execution path in jsh-executor.ts (CLI mode)

**Files:**

- Modify: `packages/webapp/src/shell/jsh-executor.ts`
- Modify: `packages/webapp/tests/shell/jsh-executor.test.ts`

- [x] **Step 1: Write failing test for ESM execution**

Add to `packages/webapp/tests/shell/jsh-executor.test.ts`:

```ts
describe('executeJsCode ESM path', () => {
  it('detects ESM imports and does not throw syntax error', async () => {
    // In test/Node environment, real import() via preview SW is not available.
    // This test verifies the detection fork happens — the ESM path will
    // fail gracefully in Node (no preview SW), but it should NOT fall through
    // to the AsyncFunction path which would throw SyntaxError on `import`.
    const code = `import chalk from 'chalk';\nconsole.log('hello');`;
    const ctx = createMockCtx();
    const result = await executeJsCode(code, ['node'], ctx);
    // Should NOT get a SyntaxError about import statements
    expect(result.stderr).not.toContain('SyntaxError');
    // In test env without preview SW, we expect a graceful error about
    // ESM execution not being available, OR it works if dynamic import resolves
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test -- packages/webapp/tests/shell/jsh-executor.test.ts`
Expected: FAIL — currently the code wraps `import` in AsyncFunction, producing SyntaxError.

- [x] **Step 3: Add ESM execution fork to `executeJsCode`**

At the top of `executeJsCode` in `packages/webapp/src/shell/jsh-executor.ts`, after the shim setup but before the `isExtensionMode` check, add the ESM detection fork:

```ts
import { hasESMImports, extractImportSpecifiers } from './supplemental-commands/shared.js';
import { buildImportMap } from './esm-import-map.js';
```

Then, inside `executeJsCode`, after the `moduleShim` declaration and before `try {`:

```ts
// ── ESM execution path ──────────────────────────────────────────────
if (hasESMImports(code)) {
  return executeEsmModule(code, argv, fsBridge, processShim, nodeConsole, execBridge);
}
```

And add the new function in the same file:

```ts
async function executeEsmModule(
  code: string,
  argv: string[],
  fsBridge: Record<string, unknown>,
  processShim: Record<string, unknown>,
  nodeConsole: Record<string, (...args: unknown[]) => void>,
  execBridge: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): Promise<JshResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Capture console output
  const origConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args: unknown[]) =>
    stdoutChunks.push(args.map(formatConsoleArg).join(' ') + '\n');
  console.info = (...args: unknown[]) =>
    stdoutChunks.push(args.map(formatConsoleArg).join(' ') + '\n');
  console.warn = (...args: unknown[]) =>
    stderrChunks.push(args.map(formatConsoleArg).join(' ') + '\n');
  console.error = (...args: unknown[]) =>
    stderrChunks.push(args.map(formatConsoleArg).join(' ') + '\n');

  try {
    // Set up globalThis shims
    (globalThis as Record<string, unknown>).__slicc_fs = fsBridge;
    (globalThis as Record<string, unknown>).__slicc_process = processShim;
    (globalThis as Record<string, unknown>).__slicc_console = nodeConsole;
    (globalThis as Record<string, unknown>).__slicc_exec = execBridge;

    // Extract specifiers and build import map
    const specifiers = extractImportSpecifiers(code);
    const importMap = buildImportMap(specifiers);

    // Inject import map into the document
    if (typeof document !== 'undefined') {
      const script = document.createElement('script');
      script.type = 'importmap';
      script.textContent = JSON.stringify(importMap);
      document.head.appendChild(script);
    }

    // Write code to a temp VFS path and execute via preview URL
    const tempPath = `/workspace/.slicc/esm-temp/${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`;
    if (typeof (globalThis as Record<string, unknown>).__slicc_fs === 'object') {
      const fs = fsBridge as {
        writeFile: (path: string, content: string) => Promise<void>;
        mkdir?: (path: string) => Promise<void>;
      };
      if (fs.mkdir) await fs.mkdir('/workspace/.slicc/esm-temp');
      await fs.writeFile(tempPath, code);
    }

    const previewUrl = `/preview${tempPath}`;
    await import(/* @vite-ignore */ previewUrl);

    return {
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      exitCode: 0,
    };
  } catch (err) {
    if (err instanceof NodeExitError) {
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: err.code,
      };
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return {
      stdout: stdoutChunks.join(''),
      stderr: `${stderrChunks.join('')}${message}\n`,
      exitCode: 1,
    };
  } finally {
    // Restore console
    console.log = origConsole.log;
    console.info = origConsole.info;
    console.warn = origConsole.warn;
    console.error = origConsole.error;

    // Clean up globalThis
    delete (globalThis as Record<string, unknown>).__slicc_fs;
    delete (globalThis as Record<string, unknown>).__slicc_process;
    delete (globalThis as Record<string, unknown>).__slicc_console;
    delete (globalThis as Record<string, unknown>).__slicc_exec;
  }
}
```

- [x] **Step 4: Run tests to verify the ESM path is taken**

Run: `npm run test -- packages/webapp/tests/shell/jsh-executor.test.ts`
Expected: PASS — ESM code no longer hits the AsyncFunction path.

- [x] **Step 5: Verify existing CJS tests still pass**

Run: `npm run test -- packages/webapp/tests/shell/jsh-executor.test.ts`
Expected: All existing tests still pass — the CJS path is untouched.

- [x] **Step 6: Run Prettier and typecheck**

```bash
npx prettier --write packages/webapp/src/shell/jsh-executor.ts packages/webapp/tests/shell/jsh-executor.test.ts
npm run typecheck
```

- [x] **Step 7: Commit**

```bash
git add packages/webapp/src/shell/jsh-executor.ts packages/webapp/tests/shell/jsh-executor.test.ts
git commit -m "feat(shell): add ESM execution path to jsh-executor with import map + preview SW"
```

---

### Task 5: Add ESM execution path to node-command.ts

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/node-command.ts`

- [x] **Step 1: Add the ESM detection fork to `createNodeCommand`**

In `packages/webapp/src/shell/supplemental-commands/node-command.ts`, add the imports at the top:

```ts
import { hasESMImports } from './shared.js';
```

Then in the `createNodeCommand` function, after the code/filename/argv are determined (after line 107) and before `const stdoutChunks`, add:

```ts
// Fork to ESM path if static import statements are detected
if (hasESMImports(code)) {
  const { executeJsCode } = await import('../jsh-executor.js');
  return executeJsCode(code, argv, ctx);
}
```

This delegates to the same `executeJsCode` ESM path implemented in Task 4, avoiding duplication.

- [x] **Step 2: Verify existing behavior is preserved**

Run: `npm run test`
Expected: All tests pass. The `node -e` command delegates to the jsh-executor ESM path when imports are detected and uses its own CJS path otherwise.

- [x] **Step 3: Run Prettier and typecheck**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/node-command.ts
npm run typecheck
```

- [x] **Step 4: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/node-command.ts
git commit -m "feat(shell): route node -e ESM scripts through jsh-executor ESM path"
```

---

### Task 6: Add ESM support to extension sandbox (sandbox.html)

**Files:**

- Modify: `packages/chrome-extension/sandbox.html`

- [x] **Step 1: Add `esm_exec` message handler to sandbox.html**

In `packages/chrome-extension/sandbox.html`, add a new message handler after the existing `exec` handler (after line 197). This handles ESM execution in extension mode where the main page can't do `import()` due to CSP:

```js
if (msg.type === 'esm_exec') {
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;

  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => logs.push('[error] ' + args.map(String).join(' '));
  console.warn = (...args) => logs.push('[warn] ' + args.map(String).join(' '));
  console.info = (...args) => logs.push(args.map(String).join(' '));

  // Set up globalThis shims
  globalThis.__slicc_fs = fs;
  globalThis.__slicc_process = {
    argv: msg.argv || ['node'],
    env: msg.env || {},
    cwd: () => msg.cwd || '/workspace',
    exit: (c) => {
      throw { __nodeExitCode: c || 0 };
    },
    stdout: {
      write: (s) => {
        logs.push(String(s));
        return true;
      },
    },
    stderr: {
      write: (s) => {
        logs.push('[error] ' + String(s));
        return true;
      },
    },
  };

  try {
    // Inject import map if provided
    if (msg.importMap) {
      const script = document.createElement('script');
      script.type = 'importmap';
      script.textContent = JSON.stringify(msg.importMap);
      document.head.appendChild(script);
    }

    // Execute as real ES module via blob URL
    const blob = new Blob([msg.code], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await import(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    const stdout = logs
      .filter((l) => !l.startsWith('[error]') && !l.startsWith('[warn]'))
      .join('\n');
    const stderr = logs
      .filter((l) => l.startsWith('[error]') || l.startsWith('[warn]'))
      .map((l) => l.replace(/^\[(error|warn)\] /, ''))
      .join('\n');

    parent.postMessage(
      {
        type: 'exec_result',
        id: msg.id,
        result: JSON.stringify({
          stdout: stdout ? stdout + '\n' : '',
          stderr: stderr ? stderr + '\n' : '',
        }),
        logs,
      },
      '*'
    );
  } catch (err) {
    if (err && err.__nodeExitCode !== undefined) {
      parent.postMessage(
        {
          type: 'exec_result',
          id: msg.id,
          result: JSON.stringify({ stdout: '', stderr: '' }),
          logs,
        },
        '*'
      );
    } else {
      parent.postMessage(
        {
          type: 'exec_result',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
          logs,
        },
        '*'
      );
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    console.info = origInfo;
    delete globalThis.__slicc_fs;
    delete globalThis.__slicc_process;
  }
  return;
}
```

- [x] **Step 2: Update extension ESM path in jsh-executor to use `esm_exec` message**

In the `executeEsmModule` function in `packages/webapp/src/shell/jsh-executor.ts`, add an extension-mode branch before the CLI `document`-based import map injection:

```ts
const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

if (isExtensionMode) {
  // Extension mode: delegate to sandbox.html's esm_exec handler
  let sandbox = document.querySelector('iframe[data-js-tool]') as HTMLIFrameElement | null;
  if (!sandbox) {
    sandbox = document.createElement('iframe');
    sandbox.style.display = 'none';
    sandbox.dataset.jsTool = 'true';
    sandbox.src = chrome.runtime.getURL('sandbox.html');
    document.body.appendChild(sandbox);
    await new Promise<void>((resolve) => {
      sandbox!.addEventListener('load', () => resolve(), { once: true });
    });
  }

  const execId = `esm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Register VFS, shell exec, and fetch proxy handlers (same as CJS extension path)
  // ... (reuse the existing handler registration pattern from the CJS extension path)

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'exec_result' && event.data.id === execId) {
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
        if (event.data.error) {
          resolve({ stdout: '', stderr: event.data.error + '\n' });
        } else {
          try {
            const parsed = JSON.parse(event.data.result);
            resolve({ stdout: parsed.stdout || '', stderr: parsed.stderr || '' });
          } catch {
            resolve({ stdout: event.data.result || '', stderr: '' });
          }
        }
      }
    };
    timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('esm eval timed out (30s)'));
    }, 30000);
    window.addEventListener('message', handler);
    sandbox!.contentWindow!.postMessage(
      {
        type: 'esm_exec',
        id: execId,
        code,
        importMap,
        argv,
        env: processShim.env,
        cwd: typeof processShim.cwd === 'function' ? processShim.cwd() : processShim.cwd,
      },
      '*'
    );
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.stderr ? 1 : 0,
  };
}
```

- [x] **Step 3: Run Prettier, typecheck, and build extension**

```bash
npx prettier --write packages/chrome-extension/sandbox.html packages/webapp/src/shell/jsh-executor.ts
npm run typecheck
npm run build -w @slicc/chrome-extension
```

- [x] **Step 4: Commit**

```bash
git add packages/chrome-extension/sandbox.html packages/webapp/src/shell/jsh-executor.ts
git commit -m "feat(extension): add esm_exec handler to sandbox for ESM module execution"
```

---

### Task 7: Full verification

**Files:** None (verification only)

- [x] **Step 1: Run full test suite**

```bash
npm run test
```

Expected: All tests pass.

- [x] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: Clean.

- [x] **Step 3: Run production build**

```bash
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: Both builds succeed.

- [ ] **Step 4: Manual smoke test in dev mode**

```bash
npm run dev
```

In the SLICC terminal, test:

1. CJS still works:

```bash
node -e "const chalk = require('chalk'); console.log('cjs works');"
```

2. ESM basic:

```bash
node -e "import { readFile } from 'fs'; const content = await readFile('/shared/CLAUDE.md'); console.log(content.slice(0, 50));"
```

3. ESM npm package:

```bash
node -e "import dayjs from 'dayjs'; console.log(dayjs().format('YYYY-MM-DD'));"
```

- [ ] **Step 5: Commit any fixups from smoke testing**

```bash
git add -A
git commit -m "fix: address smoke test issues in ESM execution path"
```

(Skip this step if no fixups needed.)
