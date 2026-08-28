import { describe, expect, it } from 'vitest';
import {
  APPROVALS_FILE,
  applyDefaultDisposition,
  builtinScoopGrants,
  commandGlobToRegExp,
  emptyPolicy,
  matchCommand,
  matchPath,
  mergePolicies,
  PROTECTED_LAYOUTS_DIR,
  parseSudoers,
  pathGlobToRegExp,
  SUDOERS_D_DIR,
  SUDOERS_FILE,
  type SudoersPolicy,
  sanitizeGrantPattern,
  scoopSudoersPath,
} from '../../src/base/sudoers.js';
import { NO_OP_WRITE_DEVICE_PATHS } from '../../src/fs/virtual-device-paths.js';

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

describe('approvals-file self-protection invariant', () => {
  // `/etc/APPROVALS.md` decides what a biscotto GUEST may do. A cone acting on
  // a guest's message must not be able to rewrite the rules gating that same
  // guest without the owner seeing a prompt — so a broad `/etc` grant, or a
  // NOPASSWD on the exact path, must not get through.
  const grant: SudoersPolicy = parseSudoers(
    `NOPASSWD Write /etc/**\nNOPASSWD Write ${APPROVALS_FILE}`
  );

  it('always requires approval for writes, even with NOPASSWD', () => {
    expect(matchPath(grant, 'write', APPROVALS_FILE)).toBe('require-approval');
  });

  it('protects it under an empty policy too', () => {
    expect(matchPath(emptyPolicy(), 'write', APPROVALS_FILE)).toBe('require-approval');
  });

  it('does not gate READS — the runtime has to load it to run a decision', () => {
    // Self-protection is write-only, same as for sudoers: neither policy grants
    // a Read rule, so a read simply does not match rather than being refused.
    expect(matchPath(grant, 'read', APPROVALS_FILE)).toBe('no-match');
    expect(matchPath(emptyPolicy(), 'read', APPROVALS_FILE)).toBe('no-match');
  });
});

describe('protected layouts self-protection invariant', () => {
  // The protected layout root is where an embedder-pushed or user-pinned
  // arrangement lives. Writes must be gated no matter what the policy says, so a
  // broad grant over /etc (or a NOPASSWD on the exact path) cannot let the agent
  // silently rewrite the UI the user pinned.
  const grant: SudoersPolicy = parseSudoers(
    `NOPASSWD Write /etc/**\nNOPASSWD Write ${PROTECTED_LAYOUTS_DIR}/**`
  );

  it('always requires approval for writes under /etc/slicc/layouts, even with NOPASSWD', () => {
    expect(matchPath(grant, 'write', `${PROTECTED_LAYOUTS_DIR}/pinned.json`)).toBe(
      'require-approval'
    );
    expect(matchPath(grant, 'write', PROTECTED_LAYOUTS_DIR)).toBe('require-approval');
  });

  it('protects them under an empty policy too', () => {
    expect(matchPath(emptyPolicy(), 'write', `${PROTECTED_LAYOUTS_DIR}/a.json`)).toBe(
      'require-approval'
    );
  });

  it('allows READS so a layout can be loaded without prompting', () => {
    // Loading a pinned layout at boot must never prompt — only changing it does.
    // Both dispositions here mean "not gated": the grant above only covers
    // writes, so a read falls through to `no-match` rather than matching it.
    expect(matchPath(grant, 'read', `${PROTECTED_LAYOUTS_DIR}/pinned.json`)).toBe('no-match');
    expect(matchPath(emptyPolicy(), 'read', `${PROTECTED_LAYOUTS_DIR}/pinned.json`)).toBe(
      'no-match'
    );
  });

  it('does NOT gate the freely-writable user layout root', () => {
    // Saving a layout is ordinary agent work; SLICC does not prompt for that.
    expect(matchPath(emptyPolicy(), 'write', '/workspace/layouts/mine.json')).toBe('no-match');
  });

  it('does not over-reach to a similarly named sibling path', () => {
    expect(matchPath(emptyPolicy(), 'write', '/etc/slicc/layouts-backup.json')).toBe('no-match');
    expect(matchPath(emptyPolicy(), 'write', '/etc/slicc/other.json')).toBe('no-match');
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
    it(`always permits content writes to ${devicePath} under an empty policy`, () => {
      expect(matchPath(emptyPolicy(), 'write', devicePath, { isContentWrite: true })).toBe(
        'nopasswd-allow'
      );
    });

    it(`always permits content writes to ${devicePath} with unrelated rules present`, () => {
      expect(matchPath(withRules, 'write', devicePath, { isContentWrite: true })).toBe(
        'nopasswd-allow'
      );
    });

    it(`normalizes paths before permitting ${devicePath} content writes`, () => {
      expect(
        matchPath(emptyPolicy(), 'write', `${devicePath}/../null`, { isContentWrite: true })
      ).toBe('nopasswd-allow');
    });

    it(`does NOT auto-permit STRUCTURAL writes to ${devicePath} (no content flag)`, () => {
      expect(matchPath(emptyPolicy(), 'write', devicePath)).toBe('no-match');
      expect(matchPath(withRules, 'write', devicePath)).toBe('no-match');
    });

    it(`leaves reads of ${devicePath} unaffected (no-match)`, () => {
      expect(matchPath(emptyPolicy(), 'read', devicePath)).toBe('no-match');
      expect(matchPath(withRules, 'read', devicePath)).toBe('no-match');
    });
  }
});

describe('ephemeral shell descriptor invariant', () => {
  // Rules that would otherwise gate the descriptor: a require-approval Write
  // covering it, plus a require-approval Read (an fd number varies per
  // invocation, so no grant can pre-empt either prompt).
  const withRules = parseSudoers('Write /dev/**\nRead /dev/**\nWrite /workspace/**');

  for (const fdPath of ['/dev/fd/63', '/dev/fd/62', '/dev/fd/10']) {
    it(`never gates a write to ${fdPath}, empty policy or not`, () => {
      expect(matchPath(emptyPolicy(), 'write', fdPath)).toBe('nopasswd-allow');
      expect(matchPath(withRules, 'write', fdPath)).toBe('nopasswd-allow');
      expect(matchPath(withRules, 'write', fdPath, { isContentWrite: true })).toBe(
        'nopasswd-allow'
      );
    });

    it(`never gates a read of ${fdPath}, empty policy or not`, () => {
      expect(matchPath(emptyPolicy(), 'read', fdPath)).toBe('nopasswd-allow');
      expect(matchPath(withRules, 'read', fdPath)).toBe('nopasswd-allow');
    });

    it(`survives the default-disposition upgrade for ${fdPath}`, () => {
      // The sandbox path a scoop actually takes: an unmatched write would be
      // upgraded to a cone approval, which is what stalled the scoop (#2502).
      expect(
        applyDefaultDisposition(
          matchPath(emptyPolicy(), 'write', fdPath, { isContentWrite: true }),
          'require-approval'
        )
      ).toBe('nopasswd-allow');
    });
  }

  it('normalizes before exempting', () => {
    expect(matchPath(emptyPolicy(), 'write', '/dev/fd/./63')).toBe('nopasswd-allow');
  });

  it('exempts only numbered descriptors, not the directory or a named child', () => {
    for (const path of ['/dev/fd', '/dev/fd/', '/dev/fd/name', '/dev/fd/63/x', '/dev/fdx/63']) {
      expect(matchPath(emptyPolicy(), 'write', path)).toBe('no-match');
    }
  });

  it('cannot override self-protection', () => {
    // Belt-and-braces: the sudoers files are not under /dev/fd, but the
    // self-protection check must stay ordered first regardless.
    expect(matchPath(emptyPolicy(), 'write', SUDOERS_FILE)).toBe('require-approval');
  });
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

describe('builtinScoopGrants', () => {
  it('grants read + write on /tmp and everything under it', () => {
    const p = builtinScoopGrants();
    expect(matchPath(p, 'write', '/tmp')).toBe('nopasswd-allow');
    expect(matchPath(p, 'write', '/tmp/scratch.txt')).toBe('nopasswd-allow');
    expect(matchPath(p, 'write', '/tmp/nested/deep/file.bin')).toBe('nopasswd-allow');
    expect(matchPath(p, 'read', '/tmp/scratch.txt')).toBe('nopasswd-allow');
  });

  it('grants nothing outside /tmp', () => {
    const p = builtinScoopGrants();
    expect(matchPath(p, 'write', '/workspace/file.txt')).toBe('no-match');
    expect(matchPath(p, 'write', '/tmpfoo/file.txt')).toBe('no-match');
    expect(matchPath(p, 'read', '/shared/secrets/aws.env')).toBe('no-match');
    expect(p.cmnd).toEqual([]);
  });

  it('cannot override self-protection on the sudoers files', () => {
    const p = builtinScoopGrants();
    expect(matchPath(p, 'write', SUDOERS_FILE)).toBe('require-approval');
    expect(matchPath(p, 'write', `${SUDOERS_D_DIR}/granted`)).toBe('require-approval');
  });

  it('still escalates an unmatched write under the require-approval default', () => {
    const p = builtinScoopGrants();
    expect(applyDefaultDisposition(matchPath(p, 'write', '/tmp/x'), 'require-approval')).toBe(
      'nopasswd-allow'
    );
    expect(applyDefaultDisposition(matchPath(p, 'write', '/etc/models'), 'require-approval')).toBe(
      'require-approval'
    );
  });

  it('returns a stable shared policy without recompiling', () => {
    expect(builtinScoopGrants()).toBe(builtinScoopGrants());
  });
});
