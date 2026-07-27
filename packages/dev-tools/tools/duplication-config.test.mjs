import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const configPath = resolve(repoRoot, 'jscpd.json');
const jscpdBin = resolve(repoRoot, 'node_modules/.bin/jscpd');

const config = JSON.parse(readFileSync(configPath, 'utf8'));

/**
 * The eight shipped applications, with the jscpd format each one's primary
 * language must be tokenized as. A zero-file scan for any of these means the
 * duplication signal silently stopped covering an app.
 */
const APPLICATIONS = {
  'packages/webapp': 'typescript',
  'packages/node-server': 'typescript',
  'packages/chrome-extension': 'typescript',
  'packages/cloudflare-worker': 'typescript',
  'packages/swift-launcher': 'swift',
  'packages/swift-server': 'swift',
  'packages/ios-app': 'swift',
  'packages/slicc-cli': 'go',
};

let reportDir;

afterAll(() => {
  if (reportDir) rmSync(reportDir, { recursive: true, force: true });
});

/** Scan one path with the repo config and return jscpd's statistics block. */
function scan(relPath) {
  reportDir ??= mkdtempSync(join(tmpdir(), 'jscpd-config-test-'));
  execFileSync(
    jscpdBin,
    [
      '--config',
      configPath,
      '--reporters',
      'json,silent',
      '--output',
      reportDir,
      '--threshold',
      '100',
      '--no-tips',
      '--no-colors',
      relPath,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }
  );
  return JSON.parse(readFileSync(join(reportDir, 'jscpd-report.json'), 'utf8')).statistics;
}

describe('jscpd.json', () => {
  it('scans the packages tree', () => {
    expect(config.path).toContain('packages');
  });

  it('declares every language the applications are written in', () => {
    for (const format of Object.values(APPLICATIONS)) {
      expect(config.format).toContain(format);
    }
  });

  it('has a threshold that is a concrete percentage', () => {
    expect(typeof config.threshold).toBe('number');
    expect(config.threshold).toBeGreaterThan(0);
    expect(config.threshold).toBeLessThan(100);
  });

  it('does not ignore an application root', () => {
    for (const app of Object.keys(APPLICATIONS)) {
      for (const pattern of config.ignore) {
        expect(pattern).not.toBe(app);
        expect(pattern).not.toBe(`${app}/**`);
        expect(pattern).not.toBe(`${app}/`);
        expect(pattern).not.toBe(`${app}/src/**`);
      }
    }
  });

  it('has no stale single-file ignore entries', () => {
    const singleFilePatterns = config.ignore.filter((p) => !p.includes('*'));
    expect(singleFilePatterns.length).toBeGreaterThan(0);
    for (const pattern of singleFilePatterns) {
      expect(existsSync(resolve(repoRoot, pattern)), `${pattern} no longer exists`).toBe(true);
    }
  });
});

describe('jscpd coverage of the shipped applications', () => {
  for (const [app, format] of Object.entries(APPLICATIONS)) {
    it(`tokenizes ${app} as ${format}`, () => {
      const stats = scan(app);
      expect(stats.total.sources).toBeGreaterThan(0);
      expect(stats.formats[format]?.sources ?? 0).toBeGreaterThan(0);
    });
  }
});
