import { describe, expect, it } from 'vitest';
import { makeCtx, runCode, runScript } from './cjs-realm-harness.js';

describe('VAL-IPX-012: a plain-CJS entry runs in sloppy mode', () => {
  it('`node -e` with a strict-only reserved-word identifier prints 42 and exits 0', async () => {
    const out = await runCode('var implements = 41;\nconsole.log(implements + 1);', makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('42');
    expect(out.stderr).not.toMatch(/reserved word/i);
  });

  it('`node <script.js>` with the same construct prints 42 and exits 0', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/sloppy.js': 'var implements = 41;\nconsole.log(implements + 1);\n',
      },
    });
    const out = await runScript('/workspace/sloppy.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('42');
    expect(out.stderr).not.toMatch(/reserved word/i);
  });

  it('another strict-only reserved word (`interface`) is also a legal sloppy identifier', async () => {
    const out = await runCode('var interface = 1;\nconsole.log("ok:" + interface);', makeCtx());
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('ok:1');
  });
});

describe('VAL-IPX-012: an ESM-derived entry stays strict', () => {
  it('an ESM entry (.mjs) using the same reserved word fails to parse (non-zero RC)', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/strict.mjs':
          "import 'sliccy:time';\nvar implements = 1;\nconsole.log(implements);\n",
      },
    });
    const out = await runScript('/workspace/strict.mjs', ctx);
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout).not.toContain('1');
    expect(out.stderr.length).toBeGreaterThan(0);
  });

  it('a valid ESM entry runs strict and succeeds (positive control)', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/ok.mjs': "import 'sliccy:time';\nconsole.log('esm-ran');\n",
      },
    });
    const out = await runScript('/workspace/ok.mjs', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('esm-ran');
  });
});
