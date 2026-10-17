import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'require-verdict.mjs');
const run = (body) =>
  spawnSync(process.execPath, [script, 'gate', '--', process.execPath, '-e', body], {
    encoding: 'utf8',
  });

describe('require-verdict', () => {
  it('passes when the gate exits 0 and prints its PASS line', () => {
    const result = run("console.log('working'); console.log('gate: PASS 3 checks')");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate: PASS 3 checks');
  });

  it('accepts the verdict on stderr', () => {
    expect(run("console.error('gate: PASS')").status).toBe(0);
  });

  it('finds a PASS on stdout while stderr holds an unfinished line', () => {
    const result = run(
      "process.stderr.write('partial-no-newline'); setTimeout(() => process.stdout.write('gate: PASS ok\\n'), 50)"
    );
    expect(result.status).toBe(0);
  });

  it('fails a gate that exits 0 silently', () => {
    const result = run('');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exited 0 without printing "gate: PASS"');
  });

  it('fails a gate that exits 0 but reports FAIL', () => {
    expect(run("console.log('gate: FAIL lint')").status).toBe(1);
  });

  it('keeps a failing exit status', () => {
    expect(run("console.log('gate: PASS'); process.exit(3)").status).toBe(3);
  });

  it('ignores a PASS for another label or mid-line', () => {
    expect(run("console.log('other: PASS'); console.log('x gate: PASS')").status).toBe(1);
  });

  it('exits 2 with usage when the separator is missing', () => {
    const result = spawnSync(process.execPath, [script, 'gate', 'node'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
