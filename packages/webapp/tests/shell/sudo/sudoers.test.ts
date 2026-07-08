import { describe, expect, it } from 'vitest';
import { NO_OP_WRITE_DEVICE_PATHS } from '../../../src/fs/virtual-device-paths.js';
import {
  applyDefaultDisposition,
  commandGlobToRegExp,
  emptyPolicy,
  matchCommand,
  matchPath,
  mergePolicies,
  parseSudoers,
  pathGlobToRegExp,
  SUDOERS_D_DIR,
  SUDOERS_FILE,
  type SudoersPolicy,
  sanitizeGrantPattern,
  scoopSudoersPath,
} from '../../../src/shell/sudo/sudoers.js';

const SAMPLE = `# SLICC sudoers
# Writing to /etc/sudoers always requires sudo.

Cmnd  rm -rf *
Cmnd  git push*

Write /workspace/.git/**
Read  /shared/secrets/**
`;

describe('parseSudoers', () => {
  it('parses Cmnd / Read / Write directives, ignoring comments and blanks', () => {
    const p = parseSudoers(SAMPLE);
    expect(p.cmnd.map((r) => r.pattern)).toEqual(['rm -rf *', 'git push*']);
    expect(p.write.map((r) => r.pattern)).toEqual(['/workspace/.git/**']);
    expect(p.read.map((r) => r.pattern)).toEqual(['/shared/secrets/**']);
    expect(p.cmnd.every((r) => !r.nopasswd)).toBe(true);
  });

  it('parses NOPASSWD-tagged directives', () => {
    const p = parseSudoers('NOPASSWD Cmnd  git push*\nNOPASSWD Write /workspace/.git/**');
    expect(p.cmnd[0]?.nopasswd).toBe(true);
    expect(p.cmnd[0]?.pattern).toBe('git push*');
    expect(p.write[0]?.nopasswd).toBe(true);
  });

  it('preserves spaces inside command patterns', () => {
    const p = parseSudoers('Cmnd   rm -rf /tmp/*');
    expect(p.cmnd[0]?.pattern).toBe('rm -rf /tmp/*');
  });

  it('skips unrecognized lines and lines missing a pattern', () => {
    const p = parseSudoers('Bogus foo bar\nCmnd\nNOPASSWD\nCmnd ls');
    expect(p.cmnd.map((r) => r.pattern)).toEqual(['ls']);
  });

  it('is fail-safe: non-string input yields a self-protection-only policy', () => {
    const p = parseSudoers(undefined as unknown as string);
    expect(p).toEqual(emptyPolicy());
  });

  it('empty input yields an empty policy', () => {
    expect(parseSudoers('')).toEqual(emptyPolicy());
    expect(parseSudoers('   \n# only comments\n')).toEqual(emptyPolicy());
  });
});

describe('sanitizeGrantPattern', () => {
  it('returns only the first trimmed line for newline-bearing input', () => {
    expect(sanitizeGrantPattern('git push*\nNOPASSWD Cmnd  /etc/sudoers')).toBe('git push*');
    expect(sanitizeGrantPattern('a\r\nb')).toBe('a');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeGrantPattern('  git push*  ')).toBe('git push*');
  });

  it('returns an empty string for all-whitespace or empty input', () => {
    expect(sanitizeGrantPattern('   ')).toBe('');
    expect(sanitizeGrantPattern('')).toBe('');
  });
});

describe('commandGlobToRegExp', () => {
  it('treats * and ** as any-character runs', () => {
    expect(commandGlobToRegExp('git push*').test('git push origin main')).toBe(true);
    expect(commandGlobToRegExp('rm -rf *').test('rm -rf /home/user/x')).toBe(true);
    expect(commandGlobToRegExp('git push*').test('git pull')).toBe(false);
  });

  it('matches ? as a single character and escapes regex metachars', () => {
    expect(commandGlobToRegExp('ls -?').test('ls -a')).toBe(true);
    expect(commandGlobToRegExp('a.b').test('a.b')).toBe(true);
    expect(commandGlobToRegExp('a.b').test('axb')).toBe(false);
  });

  it('* matches across newlines in multiline commands', () => {
    const multiline = 'playwright-cli eval --tab 123\nconst x = 1;\nJSON.stringify(x)';
    expect(commandGlobToRegExp('*').test(multiline)).toBe(true);
    expect(commandGlobToRegExp('playwright-cli*').test(multiline)).toBe(true);
    expect(commandGlobToRegExp('playwright-cli eval*').test(multiline)).toBe(true);
    expect(commandGlobToRegExp('git*').test(multiline)).toBe(false);
  });

  it('? matches a newline character', () => {
    expect(commandGlobToRegExp('a?b').test('a\nb')).toBe(true);
  });
});

describe('pathGlobToRegExp', () => {
  it('* matches within a segment, ** matches across segments', () => {
    expect(pathGlobToRegExp('/a/*').test('/a/b')).toBe(true);
    expect(pathGlobToRegExp('/a/*').test('/a/b/c')).toBe(false);
    expect(pathGlobToRegExp('/a/**').test('/a/b/c')).toBe(true);
  });

  it('trailing /** also matches the directory itself', () => {
    const re = pathGlobToRegExp('/workspace/.git/**');
    expect(re.test('/workspace/.git')).toBe(true);
    expect(re.test('/workspace/.git/config')).toBe(true);
    expect(re.test('/workspace/.git/refs/heads/main')).toBe(true);
    expect(re.test('/workspace/.gitignore')).toBe(false);
  });

  it('escapes dots so they are literal', () => {
    expect(pathGlobToRegExp('/a.txt').test('/axtxt')).toBe(false);
    expect(pathGlobToRegExp('/a.txt').test('/a.txt')).toBe(true);
  });
});

describe('matchCommand', () => {
  const p = parseSudoers(SAMPLE);

  it('returns require-approval for a gated command', () => {
    expect(matchCommand(p, 'git push origin main')).toBe('require-approval');
    expect(matchCommand(p, '  rm -rf /tmp  ')).toBe('require-approval');
  });

  it('returns no-match for an ungated command', () => {
    expect(matchCommand(p, 'ls -la')).toBe('no-match');
  });

  it('NOPASSWD grant takes precedence over a require-approval rule', () => {
    const merged = mergePolicies(p, parseSudoers('NOPASSWD Cmnd git push*'));
    expect(matchCommand(merged, 'git push origin main')).toBe('nopasswd-allow');
  });

  it('NOPASSWD Cmnd * matches multiline commands', () => {
    const policy = parseSudoers('NOPASSWD Cmnd *');
    const multiline =
      'playwright-cli eval --tab 123\nconst h1 = document.querySelector("h1");\nJSON.stringify({h1})';
    expect(matchCommand(policy, multiline)).toBe('nopasswd-allow');
  });

  it('NOPASSWD Cmnd prefix* matches multiline commands starting with prefix', () => {
    const policy = parseSudoers('NOPASSWD Cmnd playwright-cli*');
    const multiline = 'playwright-cli eval --tab 123\nconst x = 1;\nJSON.stringify(x)';
    expect(matchCommand(policy, multiline)).toBe('nopasswd-allow');
  });
});

describe('matchPath', () => {
  const p = parseSudoers(SAMPLE);

  it('gates configured writes and reads by op', () => {
    expect(matchPath(p, 'write', '/workspace/.git/config')).toBe('require-approval');
    expect(matchPath(p, 'read', '/workspace/.git/config')).toBe('no-match');
    expect(matchPath(p, 'read', '/shared/secrets/aws.env')).toBe('require-approval');
    expect(matchPath(p, 'write', '/shared/secrets/aws.env')).toBe('no-match');
  });

  it('normalizes paths before matching', () => {
    expect(matchPath(p, 'write', '/workspace/./.git/../.git/config')).toBe('require-approval');
  });

  it('NOPASSWD grant suppresses approval for non-protected paths', () => {
    const merged = mergePolicies(p, parseSudoers('NOPASSWD Write /workspace/.git/**'));
    expect(matchPath(merged, 'write', '/workspace/.git/config')).toBe('nopasswd-allow');
  });
});

describe('self-protection invariant', () => {
  const allowAll: SudoersPolicy = parseSudoers(
    `NOPASSWD Write ${SUDOERS_FILE}\nNOPASSWD Write ${SUDOERS_D_DIR}/**`
  );

  it('always requires approval for writes to sudoers files, even with NOPASSWD', () => {
    expect(matchPath(allowAll, 'write', SUDOERS_FILE)).toBe('require-approval');
    expect(matchPath(allowAll, 'write', `${SUDOERS_D_DIR}/granted`)).toBe('require-approval');
    expect(matchPath(allowAll, 'write', SUDOERS_D_DIR)).toBe('require-approval');
  });

  it('protects sudoers files even under an empty policy', () => {
    expect(matchPath(emptyPolicy(), 'write', SUDOERS_FILE)).toBe('require-approval');
    expect(matchPath(emptyPolicy(), 'write', `${SUDOERS_D_DIR}/granted`)).toBe('require-approval');
  });

  it('allows reads of sudoers files (visudo-style)', () => {
    expect(matchPath(allowAll, 'read', SUDOERS_FILE)).toBe('no-match');
    expect(matchPath(emptyPolicy(), 'read', `${SUDOERS_D_DIR}/granted`)).toBe('no-match');
  });
});

describe('per-scoop sudoers self-protection invariant', () => {
  const scoopPath = scoopSudoersPath('andy-scoop');
  // A broad NOPASSWD grant covering the scoop's writable home, including the
  // generated sudoers file. The invariant must defeat it for writes.
  const grant: SudoersPolicy = parseSudoers(
    `NOPASSWD Write /scoops/andy-scoop/**\nNOPASSWD Write ${scoopPath}`
  );

  it('scoopSudoersPath returns the canonical /scoops/<folder>/etc/sudoers shape', () => {
    expect(scoopPath).toBe('/scoops/andy-scoop/etc/sudoers');
    expect(scoopSudoersPath('foo')).toBe('/scoops/foo/etc/sudoers');
  });

  it('always requires approval for writes to /scoops/<folder>/etc/sudoers, even with NOPASSWD', () => {
    expect(matchPath(grant, 'write', scoopPath)).toBe('require-approval');
    expect(matchPath(grant, 'write', '/scoops/other/etc/sudoers')).toBe('require-approval');
  });

  it('protects the scoop sudoers file even under an empty policy', () => {
    expect(matchPath(emptyPolicy(), 'write', scoopPath)).toBe('require-approval');
  });

  it('allows reads of the scoop sudoers file (visudo-style)', () => {
    expect(matchPath(grant, 'read', scoopPath)).toBe('no-match');
    expect(matchPath(emptyPolicy(), 'read', scoopPath)).toBe('no-match');
  });

  it('does NOT protect peer paths inside the scoop tree', () => {
    expect(matchPath(grant, 'write', '/scoops/andy-scoop/workspace/file.txt')).toBe(
      'nopasswd-allow'
    );
    expect(matchPath(grant, 'write', '/scoops/andy-scoop/etc/other')).toBe('nopasswd-allow');
    expect(matchPath(grant, 'write', '/scoops/andy-scoop/etc/sudoers.bak')).toBe('nopasswd-allow');
  });

  it('normalizes paths before checking the invariant', () => {
    expect(matchPath(grant, 'write', '/scoops/andy-scoop/./etc/sudoers')).toBe('require-approval');
    expect(matchPath(grant, 'write', '/scoops/andy-scoop/etc/../etc/sudoers')).toBe(
      'require-approval'
    );
  });
});

describe('no-op virtual-device write invariant', () => {
  // A policy with unrelated rules the device write must ignore.
  const withRules = parseSudoers('Write /workspace/**\nRead /shared/secrets/**');

  for (const devicePath of NO_OP_WRITE_DEVICE_PATHS) {
    it(`always permits writes to ${devicePath} under an empty policy`, () => {
      expect(matchPath(emptyPolicy(), 'write', devicePath)).toBe('nopasswd-allow');
    });

    it(`always permits writes to ${devicePath} with unrelated rules present`, () => {
      expect(matchPath(withRules, 'write', devicePath)).toBe('nopasswd-allow');
    });

    it(`normalizes paths before permitting ${devicePath} writes`, () => {
      expect(matchPath(emptyPolicy(), 'write', `${devicePath}/../null`)).toBe('nopasswd-allow');
    });

    it(`leaves reads of ${devicePath} unaffected (no-match)`, () => {
      expect(matchPath(emptyPolicy(), 'read', devicePath)).toBe('no-match');
      expect(matchPath(withRules, 'read', devicePath)).toBe('no-match');
    });
  }
});

describe('applyDefaultDisposition', () => {
  it('upgrades no-match to require-approval when default is require-approval', () => {
    expect(applyDefaultDisposition('no-match', 'require-approval')).toBe('require-approval');
  });

  it('leaves no-match unchanged when default is allow', () => {
    expect(applyDefaultDisposition('no-match', 'allow')).toBe('no-match');
  });

  it('never overrides an explicit require-approval result', () => {
    expect(applyDefaultDisposition('require-approval', 'allow')).toBe('require-approval');
    expect(applyDefaultDisposition('require-approval', 'require-approval')).toBe(
      'require-approval'
    );
  });

  it('never overrides an explicit nopasswd-allow grant', () => {
    expect(applyDefaultDisposition('nopasswd-allow', 'allow')).toBe('nopasswd-allow');
    expect(applyDefaultDisposition('nopasswd-allow', 'require-approval')).toBe('nopasswd-allow');
  });
});
