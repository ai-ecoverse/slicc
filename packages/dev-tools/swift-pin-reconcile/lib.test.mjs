import { describe, expect, it } from 'vitest';
import {
  applyMismatches,
  checkRenovateSwiftPinSync,
  cmpSemver,
  commitShaFromTagRef,
  describeMismatch,
  dualPinKeys,
  extraRenovateNames,
  findMismatches,
  githubRepoFromUrl,
  maxVersion,
  parsePackageResolvedPins,
  parsePackageSwiftPins,
  parseProjectYmlPins,
  parseSemver,
  rangeContains,
  requiredRenovateNames,
  SWIFT_PIN_LABEL,
} from './lib.mjs';

const PROJECT_YML = `packages:
  GhosttyTerminal:
    url: https://github.com/Lakr233/libghostty-spm
    exactVersion: 1.3.2
  HuggingFace:
    url: https://github.com/huggingface/swift-huggingface
    minorVersion: 0.9.0
  WebRTC:
    url: https://github.com/stasel/WebRTC.git
    exactVersion: 150.0.0
`;

const PACKAGE_SWIFT = `
let package = Package(
    dependencies: [
        .package(url: "https://github.com/Lakr233/libghostty-spm", exact: "1.3.2"),
        .package(
            url: "https://github.com/huggingface/swift-huggingface",
            .upToNextMinor(from: "0.9.0")),
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "150.0.0")),
        .package(url: "https://github.com/hummingbird-project/hummingbird", from: "2.26.0"),
        .package(path: "../swift-trayfollower"),
    ]
)
`;

const RESOLVED = `{
  "pins" : [
    {
      "identity" : "webrtc",
      "kind" : "remoteSourceControl",
      "location" : "https://github.com/stasel/WebRTC.git",
      "state" : {
        "revision" : "abc123old",
        "version" : "150.0.0"
      }
    }
  ],
  "version" : 3
}
`;

describe('githubRepoFromUrl', () => {
  it('strips .git and lowercases the SPM identity', () => {
    expect(githubRepoFromUrl('https://github.com/stasel/WebRTC.git')).toEqual({
      owner: 'stasel',
      repo: 'WebRTC',
      identity: 'webrtc',
      key: 'stasel/webrtc',
    });
  });

  it('accepts a URL without .git', () => {
    expect(githubRepoFromUrl('https://github.com/Lakr233/libghostty-spm').identity).toBe(
      'libghostty-spm'
    );
  });

  it('returns null for a non-GitHub URL', () => {
    expect(githubRepoFromUrl('https://example.com/foo')).toBeNull();
  });
});

describe('semver', () => {
  it('parses and compares dotted triples', () => {
    expect(parseSemver('151.0.0')).toMatchObject({ major: 151, minor: 0, patch: 0 });
    expect(cmpSemver('151.0.0', '150.0.0')).toBeGreaterThan(0);
    expect(maxVersion('150.0.0', '151.0.0')).toBe('151.0.0');
  });
});

describe('rangeContains', () => {
  it('treats upToNextMajor from 150 as <151 (the PR #2348 failure)', () => {
    const req = { kind: 'upToNextMajor', version: '150.0.0' };
    expect(rangeContains(req, '150.0.0')).toBe(true);
    expect(rangeContains(req, '150.9.1')).toBe(true);
    expect(rangeContains(req, '151.0.0')).toBe(false);
  });

  it('treats upToNextMinor from 0.9 as <0.10, not as any 0.x', () => {
    const req = { kind: 'upToNextMinor', version: '0.9.0' };
    expect(rangeContains(req, '0.9.5')).toBe(true);
    expect(rangeContains(req, '0.10.0')).toBe(false);
    expect(rangeContains(req, '1.0.0')).toBe(false);
  });

  it('matches exact and open-from ranges', () => {
    expect(rangeContains({ kind: 'exact', version: '1.3.2' }, '1.3.2')).toBe(true);
    expect(rangeContains({ kind: 'exact', version: '1.3.2' }, '1.3.1')).toBe(false);
    expect(rangeContains({ kind: 'from', version: '2.26.0' }, '2.30.0')).toBe(true);
  });
});

describe('parsers', () => {
  it('reads exactVersion and minorVersion pins from project.yml', () => {
    const pins = parseProjectYmlPins(PROJECT_YML, 'packages/ios-app/project.yml');
    expect(pins.map((p) => `${p.key}:${p.kind}:${p.version}`)).toEqual([
      'lakr233/libghostty-spm:exactVersion:1.3.2',
      'huggingface/swift-huggingface:minorVersion:0.9.0',
      'stasel/webrtc:exactVersion:150.0.0',
    ]);
  });

  it('reads every Package.swift requirement kind and skips path packages', () => {
    const pins = parsePackageSwiftPins(PACKAGE_SWIFT, 'packages/ios-app/Package.swift');
    expect(pins.map((p) => `${p.identity}:${p.kind}:${p.version}`)).toEqual([
      'libghostty-spm:exact:1.3.2',
      'swift-huggingface:upToNextMinor:0.9.0',
      'webrtc:upToNextMajor:150.0.0',
      'hummingbird:from:2.26.0',
    ]);
  });

  it('reads Package.resolved version + revision', () => {
    const pins = parsePackageResolvedPins(RESOLVED, 'packages/ios-app/Package.resolved');
    expect(pins).toEqual([
      expect.objectContaining({
        identity: 'webrtc',
        key: 'stasel/webrtc',
        version: '150.0.0',
        revision: 'abc123old',
      }),
    ]);
  });

  it('returns [] for invalid resolved JSON', () => {
    expect(parsePackageResolvedPins('not-json')).toEqual([]);
  });
});

describe('findMismatches', () => {
  const projectPins = parseProjectYmlPins(PROJECT_YML, 'project.yml');
  const swiftPins = parsePackageSwiftPins(PACKAGE_SWIFT, 'Package.swift');
  const resolvedPins = parsePackageResolvedPins(RESOLVED, 'Package.resolved');

  it('treats only identities present on both sides as dual pins', () => {
    expect([...dualPinKeys({ projectPins, swiftPins })].sort()).toEqual([
      'huggingface/swift-huggingface',
      'lakr233/libghostty-spm',
      'stasel/webrtc',
    ]);
  });

  it('is silent when every dual pin already overlaps', () => {
    expect(findMismatches({ projectPins, swiftPins, resolvedPins })).toEqual([]);
  });

  it('flags project.yml 151 vs Package.swift upToNextMajor from 150 (PR #2348)', () => {
    const project = parseProjectYmlPins(
      PROJECT_YML.replace('exactVersion: 150.0.0', 'exactVersion: 151.0.0')
    );
    const out = findMismatches({ projectPins: project, swiftPins, resolvedPins });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: 'stasel/webrtc',
      targetVersion: '151.0.0',
      needsRevision: true,
    });
    expect(out[0].swiftEdits.map((e) => e.version)).toEqual(['150.0.0']);
    expect(out[0].resolvedEdits.map((e) => e.version)).toEqual(['150.0.0']);
    expect(out[0].projectEdits).toEqual([]);
  });

  it('flags Package.swift 151 vs project.yml 150 (PR #2320)', () => {
    const swift = parsePackageSwiftPins(
      PACKAGE_SWIFT.replace('.upToNextMajor(from: "150.0.0")', '.upToNextMajor(from: "151.0.0")')
    );
    const out = findMismatches({ projectPins, swiftPins: swift, resolvedPins });
    expect(out[0]).toMatchObject({ key: 'stasel/webrtc', targetVersion: '151.0.0' });
    expect(out[0].projectEdits.map((e) => e.version)).toEqual(['150.0.0']);
    expect(out[0].swiftEdits).toEqual([]);
  });

  it('does not rewrite Package.swift when exactVersion is still in-range', () => {
    const project = parseProjectYmlPins(
      PROJECT_YML.replace('exactVersion: 150.0.0', 'exactVersion: 150.9.0')
    );
    const out = findMismatches({
      projectPins: project,
      swiftPins,
      resolvedPins: parsePackageResolvedPins(RESOLVED.replace('150.0.0', '150.9.0')),
    });
    expect(out).toEqual([]);
  });

  it('flags a stale Package.resolved when the manifests already agree on the exact version', () => {
    const project = parseProjectYmlPins(PROJECT_YML.replace('150.0.0', '151.0.0'));
    const swift = parsePackageSwiftPins(PACKAGE_SWIFT.replace('150.0.0', '151.0.0'));
    const out = findMismatches({ projectPins: project, swiftPins: swift, resolvedPins });
    expect(out).toHaveLength(1);
    expect(out[0].projectEdits).toEqual([]);
    expect(out[0].swiftEdits).toEqual([]);
    expect(out[0].resolvedEdits.map((e) => e.version)).toEqual(['150.0.0']);
    expect(out[0].needsRevision).toBe(true);
  });

  it('ignores a Package.swift-only pin (hummingbird)', () => {
    const hummingbirdOnly = swiftPins.filter((p) => p.identity === 'hummingbird');
    expect(findMismatches({ projectPins, swiftPins: hummingbirdOnly, resolvedPins })).toEqual([]);
  });

  it('does not force Package.resolved onto the floor of a range-style pin', () => {
    const resolved = parsePackageResolvedPins(
      RESOLVED.replace('webrtc', 'swift-huggingface')
        .replace('stasel/WebRTC.git', 'huggingface/swift-huggingface')
        .replace('150.0.0', '0.9.5')
    );
    expect(
      findMismatches({
        projectPins,
        swiftPins,
        resolvedPins: resolved,
      })
    ).toEqual([]);
  });
});

describe('applyMismatches', () => {
  it('raises Package.swift + Package.resolved to the project.yml exactVersion', () => {
    const projectPins = parseProjectYmlPins(
      PROJECT_YML.replace('exactVersion: 150.0.0', 'exactVersion: 151.0.0'),
      'project.yml'
    );
    const swiftPins = parsePackageSwiftPins(PACKAGE_SWIFT, 'Package.swift');
    const resolvedPins = parsePackageResolvedPins(RESOLVED, 'Package.resolved');
    const mismatches = findMismatches({ projectPins, swiftPins, resolvedPins });
    const changed = applyMismatches(
      { 'Package.swift': PACKAGE_SWIFT, 'Package.resolved': RESOLVED, 'project.yml': PROJECT_YML },
      mismatches,
      { 'stasel/webrtc': 'def456new' }
    );
    expect(changed['project.yml']).toBeUndefined();
    expect(changed['Package.swift']).toContain('.upToNextMajor(from: "151.0.0")');
    expect(changed['Package.swift']).not.toContain('.upToNextMajor(from: "150.0.0")');
    expect(changed['Package.resolved']).toContain('"version" : "151.0.0"');
    expect(changed['Package.resolved']).toContain('"revision" : "def456new"');
    expect(changed['Package.resolved']).not.toContain('abc123old');
  });

  it('raises project.yml exactVersion when Package.swift is already 151', () => {
    const swiftSrc = PACKAGE_SWIFT.replace(
      '.upToNextMajor(from: "150.0.0")',
      '.upToNextMajor(from: "151.0.0")'
    );
    const mismatches = findMismatches({
      projectPins: parseProjectYmlPins(PROJECT_YML, 'project.yml'),
      swiftPins: parsePackageSwiftPins(swiftSrc, 'Package.swift'),
      resolvedPins: parsePackageResolvedPins(
        RESOLVED.replace('150.0.0', '151.0.0').replace('abc123old', 'def456new'),
        'Package.resolved'
      ),
    });
    const changed = applyMismatches({ 'project.yml': PROJECT_YML }, mismatches);
    expect(changed['project.yml']).toContain('exactVersion: 151.0.0');
    expect(changed['project.yml']).not.toContain('exactVersion: 150.0.0');
  });
});

describe('describeMismatch', () => {
  it('names each file and the version jump', () => {
    const text = describeMismatch({
      key: 'stasel/webrtc',
      targetVersion: '151.0.0',
      projectEdits: [],
      swiftEdits: [{ path: 'Package.swift', kind: 'upToNextMajor', version: '150.0.0' }],
      resolvedEdits: [{ path: 'Package.resolved', version: '150.0.0' }],
    });
    expect(text).toContain('stasel/webrtc');
    expect(text).toContain('Package.swift');
    expect(text).toContain('151.0.0');
  });
});

describe('commitShaFromTagRef', () => {
  it('uses the ref SHA for a lightweight tag', () => {
    expect(commitShaFromTagRef({ object: { type: 'commit', sha: 'abc' } })).toBe('abc');
  });

  it('peels an annotated tag', () => {
    expect(
      commitShaFromTagRef({ object: { type: 'tag', sha: 'tagobj' } }, { object: { sha: 'commit' } })
    ).toBe('commit');
  });

  it('returns null when the ref payload is empty', () => {
    expect(commitShaFromTagRef(null)).toBeNull();
  });
});

describe('checkRenovateSwiftPinSync', () => {
  const dualPins = parseProjectYmlPins(PROJECT_YML);

  it('accepts a swift-pin rule that lists every owner/repo', () => {
    const renovate = {
      packageRules: [
        {
          addLabels: [SWIFT_PIN_LABEL],
          matchPackageNames: [
            'stasel/WebRTC',
            'WebRTC',
            'Lakr233/libghostty-spm',
            'huggingface/swift-huggingface',
          ],
        },
      ],
    };
    expect(checkRenovateSwiftPinSync({ dualPins, renovate })).toEqual([]);
  });

  it('fails when the label rule is missing', () => {
    const problems = checkRenovateSwiftPinSync({ dualPins, renovate: { packageRules: [] } });
    expect(problems[0]).toMatch(new RegExp(SWIFT_PIN_LABEL));
    expect(problems[0]).toMatch(/stasel\/WebRTC/);
  });

  it('fails when a dual-pin owner/repo is not in matchPackageNames', () => {
    const problems = checkRenovateSwiftPinSync({
      dualPins,
      renovate: {
        packageRules: [{ addLabels: [SWIFT_PIN_LABEL], matchPackageNames: ['stasel/WebRTC'] }],
      },
    });
    expect(problems[0]).toMatch(/libghostty-spm/);
    expect(problems[0]).toMatch(/swift-huggingface/);
  });

  it('fails when the rule exists but there are no dual pins', () => {
    const problems = checkRenovateSwiftPinSync({
      dualPins: [],
      renovate: { packageRules: [{ addLabels: [SWIFT_PIN_LABEL], matchPackageNames: ['x'] }] },
    });
    expect(problems[0]).toMatch(/no GitHub package is dual-pinned/);
  });
});

describe('renovate name helpers', () => {
  const pin = githubRepoFromUrl('https://github.com/stasel/WebRTC.git');
  it('requires owner/repo and allows the repo-only github-releases alias', () => {
    expect(requiredRenovateNames(pin)).toEqual(['stasel/WebRTC']);
    expect(extraRenovateNames(pin)).toEqual(['WebRTC']);
  });
});
