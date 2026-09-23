/**
 * ES modules have no `__dirname`/`__filename`, so they commonly declare their
 * own from `import.meta.url` (emscripten's `src/utility.mjs` does). The realm
 * runs transpiled ESM inside a function wrapper; those names must not be
 * wrapper parameters for ESM, or the declaration is a SyntaxError. CommonJS
 * keeps them.
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runScript } from './cjs-realm-harness.js';

const OWN_DIRNAME = [
  "import { dirname } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const __filename = fileURLToPath(import.meta.url);',
  'const __dirname = dirname(__filename);',
].join('\n');

describe('ESM declaring its own __dirname / __filename', () => {
  it('works in an imported ES module', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/app/lib/where.mjs': `${OWN_DIRNAME}\nexport const where = __dirname;`,
        '/workspace/app/main.mjs': "import { where } from './lib/where.mjs';\nconsole.log(where);",
      },
    });
    const r = await runScript('/workspace/app/main.mjs', ctx);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('/workspace/app/lib');
  });

  it('works in an ES-module entry', async () => {
    const ctx = makeCtx({
      files: { '/workspace/app/main.mjs': `${OWN_DIRNAME}\nconsole.log(__dirname, __filename);` },
    });
    const r = await runScript('/workspace/app/main.mjs', ctx);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('/workspace/app /workspace/app/main.mjs');
  });

  it('still gives CommonJS modules and entries their __dirname', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/app/lib/where.js': 'module.exports = __dirname;',
        '/workspace/app/main.js': "console.log(require('./lib/where.js'), __filename);",
      },
    });
    const r = await runScript('/workspace/app/main.js', ctx);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('/workspace/app/lib /workspace/app/main.js');
  });
});
