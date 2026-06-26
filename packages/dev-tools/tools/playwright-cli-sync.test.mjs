import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, 'playwright-cli-sync.mjs');
const SLICC_MANIFEST = resolve(
  __dirname,
  '../../webapp/src/shell/supplemental-commands/playwright/slicc-commands.json'
);

function run(helpJson, sliccJson, extraArgs = []) {
  const dir = mkdtempSync(resolve(tmpdir(), 'pw-sync-test-'));
  const helpPath = resolve(dir, 'help.json');
  writeFileSync(helpPath, JSON.stringify(helpJson));
  // Point --slicc-manifest at a temp file so we don't need to mutate the real one
  const manifestPath = resolve(dir, 'slicc-commands.json');
  writeFileSync(manifestPath, JSON.stringify(sliccJson));

  try {
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        `--help-json=${helpPath}`,
        `--slicc-manifest=${manifestPath}`,
        '--json',
        ...extraArgs,
      ],
      { encoding: 'utf8' }
    );
    rmSync(dir, { recursive: true });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    rmSync(dir, { recursive: true });
    if (e.stdout) return { code: e.status, data: JSON.parse(e.stdout) };
    throw e;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHelp(commands, booleanOptions = []) {
  return {
    global: '',
    booleanOptions,
    commands: Object.fromEntries(
      Object.entries(commands).map(([name, cmd]) => [
        name,
        {
          help: cmd.helpLine ?? `playwright-cli ${name}`,
          flags: cmd.flags ?? {},
          args: cmd.args ?? [],
        },
      ])
    ),
  };
}

function makeSlicc(commands, sliccOnly = [], skipFlags = {}) {
  return {
    _slicc_only: sliccOnly,
    _official_skip_flags: skipFlags,
    commands: Object.fromEntries(
      Object.entries(commands).map(([name, cmd]) => [
        name,
        { args: cmd.args ?? [], flags: cmd.flags ?? {} },
      ])
    ),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('missing commands', () => {
  it('reports commands in official that are absent from Slicc', () => {
    const { code, data } = run(
      makeHelp({ goto: { args: ['url'] }, snapshot: { args: [] } }),
      makeSlicc({ goto: { args: ['url'] } })
    );
    expect(code).toBe(1);
    expect(data.missingCommands).toHaveLength(1);
    expect(data.missingCommands[0].name).toBe('snapshot');
  });

  it('does not report Slicc-only commands as missing', () => {
    const { code, data } = run(
      makeHelp({ goto: { args: ['url'] } }),
      makeSlicc({ goto: { args: ['url'] }, teleport: { args: [] } }, ['teleport'])
    );
    expect(code).toBe(0);
    expect(data.missingCommands).toHaveLength(0);
  });

  it('exits 0 with no gaps', () => {
    const { code } = run(
      makeHelp({ goto: { args: ['url'] } }),
      makeSlicc({ goto: { args: ['url'] } })
    );
    expect(code).toBe(0);
  });
});

describe('flag gaps', () => {
  it('reports flags present in official but absent from Slicc', () => {
    const { data } = run(
      makeHelp({ click: { args: ['target'], flags: { modifiers: 'string' } } }),
      makeSlicc({ click: { args: ['target'] } })
    );
    expect(data.flagGaps).toHaveLength(1);
    expect(data.flagGaps[0]).toMatchObject({
      command: 'click',
      missingFlags: { modifiers: 'string' },
    });
  });

  it('ignores Slicc-only flags (e.g. --tab)', () => {
    const { data } = run(
      makeHelp({ click: { args: ['target'], flags: {} } }),
      makeSlicc({ click: { args: ['target'], flags: { tab: 'string' } } })
    );
    expect(data.flagGaps).toHaveLength(0);
  });

  it('respects _official_skip_flags', () => {
    const { data } = run(
      makeHelp({ open: { args: [], flags: { browser: 'string', headed: 'boolean' } } }),
      makeSlicc({ open: { args: [] } }, [], { open: ['browser', 'headed'] })
    );
    expect(data.flagGaps).toHaveLength(0);
  });
});

describe('arg gaps', () => {
  it('reports required args in official missing from Slicc', () => {
    // upload has 1 required arg; Slicc registers it with 0 — real gap
    const { data } = run(
      makeHelp({ upload: { args: ['file'], helpLine: 'playwright-cli upload <file>' } }),
      makeSlicc({ upload: { args: [] } })
    );
    expect(data.argGaps).toHaveLength(1);
    expect(data.argGaps[0].command).toBe('upload');
  });

  it('does not report optional args as gaps', () => {
    const { data } = run(
      makeHelp({ snapshot: { args: ['target'], helpLine: 'playwright-cli snapshot [target]' } }),
      makeSlicc({ snapshot: { args: [] } })
    );
    // target is optional ([target]) — not a real gap
    expect(data.argGaps).toHaveLength(0);
  });

  it('does not report tab-close index as a gap (optional in help text)', () => {
    const { data } = run(
      makeHelp({ 'tab-close': { args: ['index'], helpLine: 'playwright-cli tab-close [index]' } }),
      makeSlicc({ 'tab-close': { args: [] } })
    );
    expect(data.argGaps).toHaveLength(0);
  });
});

describe('undeclaredSliccOnly', () => {
  it('warns about Slicc commands not in official and not listed in _slicc_only', () => {
    const { code, data } = run(
      makeHelp({ goto: { args: ['url'] } }),
      makeSlicc({ goto: { args: ['url'] }, mysteryCmd: { args: [] } })
    );
    // undeclaredSliccOnly does not cause exit 1 (informational warning)
    expect(code).toBe(0);
    expect(data.undeclaredSliccOnly).toContain('mysteryCmd');
  });
});

describe('real manifest smoke test', () => {
  it('slicc-commands.json parses without error and has expected shape', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(SLICC_MANIFEST, 'utf8'));
    expect(manifest.commands).toBeDefined();
    expect(manifest._slicc_only).toBeInstanceOf(Array);
    expect(manifest._official_skip_flags).toBeDefined();
    // Every _slicc_only entry must NOT be in commands (they're extras, not tracked there)
    // Actually slicc-only entries are NOT in official help.json — no requirement they're absent from manifest
    // Just verify the known must-have commands are present
    for (const cmd of ['goto', 'click', 'fill', 'snapshot', 'screenshot', 'eval']) {
      expect(manifest.commands[cmd], `expected ${cmd} in manifest`).toBeDefined();
    }
  });
});
