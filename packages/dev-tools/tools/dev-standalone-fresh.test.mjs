import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'dev-standalone-fresh.sh');

function guardDecision(holders, forceReap = '0', port = '5715') {
  return execFileSync(
    'bash',
    [
      '-c',
      'lsof() { :; }; kill() { :; }; source "$1"; bridge_port_guard_action "$2" "$3" "$4"',
      'bash',
      scriptPath,
      port,
      holders,
      forceReap,
    ],
    { encoding: 'utf8' }
  ).trim();
}

function canonicalPort(port) {
  return execFileSync(
    'bash',
    ['-c', 'source "$1"; canonicalize_port "$2"', 'bash', scriptPath, port],
    { encoding: 'utf8' }
  ).trim();
}

function reapPort(port) {
  return spawnSync(
    'bash',
    [
      '-c',
      'lsof() { :; }; kill() { :; }; source "$1"; reap_port "$2" test',
      'bash',
      scriptPath,
      port,
    ],
    { encoding: 'utf8' }
  );
}

describe('dev-standalone-fresh bridge port guard', () => {
  it('proceeds when the bridge port has no listener', () => {
    expect(guardDecision('')).toBe('proceed');
  });

  it('fails fast when the bridge port is occupied by default', () => {
    expect(guardDecision('slicc-server 123 user')).toBe('fail-fast');
  });

  it('reaps an occupied bridge port only with the explicit opt-in', () => {
    expect(guardDecision('node 456 user', '1')).toBe('reap');
  });

  it.each(['1', '5715', '65535'])('accepts canonical decimal port %s', (port) => {
    expect(canonicalPort(port)).toBe(port);
  });

  it.each(['9222', '9223'])('refuses protected CDP port %s at both guard layers', (port) => {
    expect(guardDecision('', '0', port)).toBe('protected');
    expect(guardDecision('chrome 789 user', '1', port)).toBe('protected');

    const result = reapPort(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`protected Chrome/Electron CDP port :${port}`);
  });

  it.each([
    '09222',
    '0009222',
    ' 9222',
    '9222 ',
    '+9222',
    '\t9222',
    '-9222',
    '0x2406',
    '022026',
    '9222\n',
    '$(printf 9222)',
    '*',
    '9222-9222',
    '9222,9223',
    '9222,5710',
    'not-a-port',
    '',
    '0',
    '65536',
  ])('rejects invalid port encoding %j before any reap decision', (port) => {
    expect(guardDecision('chrome 789 user', '1', port)).toBe('invalid');

    const result = reapPort(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to reap invalid port:');
  });
});
