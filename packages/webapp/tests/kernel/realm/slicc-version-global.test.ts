import { describe, expect, it } from 'vitest';
import { readBundledVersion } from '../../../src/scoops/upgrade-detection.js';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('SLICC_VERSION realm global', () => {
  it('exposes the running version to realm scripts', async () => {
    const result = await runCode('console.log(globalThis.SLICC_VERSION)', makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(readBundledVersion().version);
  });

  it('is readable bare, not just off globalThis', async () => {
    const result = await runCode('console.log(typeof SLICC_VERSION, SLICC_VERSION)', makeCtx());

    expect(result.stdout.trim()).toBe(`string ${readBundledVersion().version}`);
  });

  it('cannot be forged by realm code', async () => {
    const forged = await runCode(
      'try { globalThis.SLICC_VERSION = "9.9.9" } catch { /* strict-mode TypeError */ }\nconsole.log(globalThis.SLICC_VERSION)',
      makeCtx()
    );

    expect(forged.stdout.trim()).toBe(readBundledVersion().version);
  });
});
