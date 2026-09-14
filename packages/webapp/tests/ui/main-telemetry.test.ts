import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = join(here, '..', '..', 'src', 'ui', 'main.ts');
const source = readFileSync(mainPath, 'utf8');

describe('ui/main.ts telemetry wiring', () => {
  it('imports initTelemetry from the telemetry module', () => {
    expect(source).toMatch(
      /import\s+\{\s*initTelemetry\s*\}\s+from\s+['"]\.\.\/kernel\/telemetry\.js['"]/
    );
  });

  it('calls initTelemetry() with a swallowed catch', () => {
    expect(source).toMatch(/initTelemetry\(\{ isExtensionRealm: isExtension \}\)\s*\.catch\(/);
  });

  it('calls initTelemetry after the fixture early-return', () => {
    const fixtureIdx = source.indexOf('isFixtureRequested(window.location.href)');
    const initIdx = source.indexOf('initTelemetry(');
    expect(fixtureIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(fixtureIdx);
  });

  it('calls initTelemetry before the heavy boot (registerProviders)', () => {
    const initIdx = source.indexOf('initTelemetry(');
    const providersIdx = source.indexOf('await registerProviders');
    expect(initIdx).toBeGreaterThan(-1);
    expect(providersIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(providersIdx);
  });

  it('passes the already-resolved isExtension local — not a fresh probe — and gates on a non-connect runtime mode', () => {
    expect(source).toMatch(
      /runtimeMode\s*!==\s*['"]connect['"][\s\S]{0,200}initTelemetry\(\{ isExtensionRealm: isExtension \}\)/
    );
  });

  it('marks connect mode via a named ConnectModeGlobal cast', () => {
    expect(source).toMatch(
      /type ConnectModeGlobal\s*=\s*\{[\s\S]*?__slicc_connect_mode\?: unknown;/
    );
    expect(source).toMatch(/\(globalThis as ConnectModeGlobal\)\.__slicc_connect_mode\s*=\s*true/);
    expect(source).not.toMatch(/Record<\s*string\s*,\s*unknown\s*>/);
  });
});
