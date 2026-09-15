/**
 * Shared test scaffolding: an isolated `$SLICC_GW_HOME`, the three GitHub
 * command files, the fake CLI on `SLICC_CLI`, and an `INPUT_*` setter that
 * is undone by `teardown()`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_SLICC = resolve(here, 'fixtures', 'fake-slicc.mjs');
export const FAKE_NODE_SERVER = resolve(here, 'fixtures', 'fake-node-server.mjs');

export function setup() {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'slicc-gw-test-'));
  const home = join(root, 'home');
  const fake = join(root, 'fake');
  const env = {
    SLICC_GW_HOME: home,
    GITHUB_OUTPUT: join(root, 'gh.out'),
    GITHUB_ENV: join(root, 'gh.env'),
    GITHUB_PATH: join(root, 'gh.path'),
    SLICC_CLI: FAKE_SLICC,
    FAKE_SLICC_DIR: fake,
    SLICC_JOIN_URL: 'https://www.sliccy.ai/join/fake.tray',
    SLICC_GW_JOIN_FILE: join(root, 'slicc-join.json'),
    SLICC_GW_CONE_CONFIG_PATH: join(root, 'slicc', 'cone-config.json'),
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key.startsWith('FAKE_')) delete process.env[key];
  }
  Object.assign(process.env, env);
  for (const f of ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH']) writeFileSync(env[f], '');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(fake, 'vfs'), { recursive: true });
  return {
    root,
    home,
    fake,
    vfs: join(fake, 'vfs'),
    joinFile: env.SLICC_GW_JOIN_FILE,
    coneConfig: env.SLICC_GW_CONE_CONFIG_PATH,
    inputs(values) {
      for (const [name, value] of Object.entries(values)) {
        const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
        if (value === undefined || value === null) delete process.env[key];
        else process.env[key] = String(value);
      }
    },
    outputs() {
      return parseCommandFile(readFileSync(env.GITHUB_OUTPUT, 'utf8'));
    },
    envFile() {
      return parseCommandFile(readFileSync(env.GITHUB_ENV, 'utf8'));
    },
    calls() {
      try {
        return readFileSync(join(fake, 'calls.log'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    teardown() {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Parse `$GITHUB_OUTPUT` / `$GITHUB_ENV` records, including heredoc values. */
export function parseCommandFile(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const [, name, delim] = heredoc;
      const body = [];
      i += 1;
      while (i < lines.length && lines[i] !== delim) body.push(lines[i++]);
      out[name] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
