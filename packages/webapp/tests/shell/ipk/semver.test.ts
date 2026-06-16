import { describe, expect, it } from 'vitest';
import {
  compare,
  comparePrerelease,
  maxSatisfying,
  parse,
  satisfies,
} from '../../../src/shell/ipk/semver.js';

describe('parse', () => {
  it('parses a plain semver', () => {
    const v = parse('1.2.3');
    expect(v.major).toBe(1);
    expect(v.minor).toBe(2);
    expect(v.patch).toBe(3);
    expect(v.prerelease).toEqual([]);
    expect(v.build).toEqual([]);
    expect(v.raw).toBe('1.2.3');
  });

  it('parses a prerelease version', () => {
    const v = parse('1.2.3-alpha');
    expect(v.prerelease).toEqual(['alpha']);
  });

  it('parses a multi-part prerelease', () => {
    const v = parse('1.0.0-alpha.1');
    expect(v.prerelease).toEqual(['alpha', '1']);
  });

  it('parses build metadata', () => {
    const v = parse('1.0.0+build.123');
    expect(v.build).toEqual(['build', '123']);
  });

  it('parses prerelease + build metadata', () => {
    const v = parse('1.0.0-rc.1+sha.5114f85');
    expect(v.prerelease).toEqual(['rc', '1']);
    expect(v.build).toEqual(['sha', '5114f85']);
  });

  it('parses leading v', () => {
    const v = parse('v1.2.3');
    expect(v.major).toBe(1);
    expect(v.minor).toBe(2);
    expect(v.patch).toBe(3);
  });

  it('parses leading V', () => {
    const v = parse('V1.2.3');
    expect(v.major).toBe(1);
  });

  it('throws on wildcard in version string (wildcards are range syntax)', () => {
    expect(() => parse('1.2.x')).toThrow();
    expect(() => parse('1.2.*')).toThrow();
    expect(() => parse('*')).toThrow();
  });

  it('throws on invalid version strings', () => {
    expect(() => parse('not-a-version')).toThrow();
    expect(() => parse('')).toThrow();
  });
});

describe('satisfies - exact', () => {
  it('matches exact version', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
  });

  it('rejects non-matching exact', () => {
    expect(satisfies('1.2.3', '1.2.4')).toBe(false);
  });

  it('rejects prerelease against exact without prerelease', () => {
    expect(satisfies('1.2.3-alpha', '1.2.3')).toBe(false);
  });

  it('matches exact prerelease', () => {
    expect(satisfies('1.2.3-alpha', '1.2.3-alpha')).toBe(true);
  });
});

describe('satisfies - caret ^', () => {
  it('^1.2.3 allows >=1.2.3 <2.0.0', () => {
    expect(satisfies('1.2.3', '^1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '^1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
  });

  it('^0.2.3 allows >=0.2.3 <0.3.0', () => {
    expect(satisfies('0.2.3', '^0.2.3')).toBe(true);
    expect(satisfies('0.2.4', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('0.2.2', '^0.2.3')).toBe(false);
  });

  it('^0.0.3 allows >=0.0.3 <0.0.4', () => {
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('0.0.2', '^0.0.3')).toBe(false);
  });

  it('^1.2.3 allows prerelease only on the same [major,minor,patch] tuple', () => {
    expect(satisfies('1.2.3-alpha', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.4-alpha', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.3-alpha', '^1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.4-alpha', '^1.2.3-alpha')).toBe(false);
  });

  it('^1.2.3-beta allows prerelease versions >=1.2.3-beta', () => {
    expect(satisfies('1.2.3-beta', '^1.2.3-beta')).toBe(true);
    expect(satisfies('1.2.3-alpha', '^1.2.3-beta')).toBe(false); // alpha < beta
    expect(satisfies('1.2.4', '^1.2.3-beta')).toBe(true);
  });
});

describe('satisfies - tilde ~', () => {
  it('~1.2.3 allows >=1.2.3 <1.3.0', () => {
    expect(satisfies('1.2.3', '~1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '~1.2.3')).toBe(false);
  });

  it('~1.2 allows >=1.2.0 <1.3.0', () => {
    expect(satisfies('1.2.0', '~1.2')).toBe(true);
    expect(satisfies('1.2.5', '~1.2')).toBe(true);
    expect(satisfies('1.3.0', '~1.2')).toBe(false);
  });

  it('~1 allows >=1.0.0 <2.0.0', () => {
    expect(satisfies('1.0.0', '~1')).toBe(true);
    expect(satisfies('1.5.0', '~1')).toBe(true);
    expect(satisfies('2.0.0', '~1')).toBe(false);
  });

  it('~0.2.3 allows >=0.2.3 <0.3.0', () => {
    expect(satisfies('0.2.3', '~0.2.3')).toBe(true);
    expect(satisfies('0.2.4', '~0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '~0.2.3')).toBe(false);
  });

  it('tilde prerelease matching follows same rules', () => {
    expect(satisfies('1.2.3-alpha', '~1.2.3')).toBe(false);
    expect(satisfies('1.2.3-alpha', '~1.2.3-alpha')).toBe(true);
  });
});

describe('satisfies - x / * wildcards', () => {
  it('* matches anything', () => {
    expect(satisfies('0.0.0', '*')).toBe(true);
    expect(satisfies('99.99.99', '*')).toBe(true);
    expect(satisfies('1.2.3-alpha', '*')).toBe(true);
  });

  it('1.x matches >=1.0.0 <2.0.0', () => {
    expect(satisfies('1.0.0', '1.x')).toBe(true);
    expect(satisfies('1.9.9', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);
    expect(satisfies('0.9.9', '1.x')).toBe(false);
  });

  it('1.2.x matches >=1.2.0 <1.3.0', () => {
    expect(satisfies('1.2.0', '1.2.x')).toBe(true);
    expect(satisfies('1.2.99', '1.2.x')).toBe(true);
    expect(satisfies('1.3.0', '1.2.x')).toBe(false);
  });

  it('1.2.* is equivalent to 1.2.x', () => {
    expect(satisfies('1.2.0', '1.2.*')).toBe(true);
    expect(satisfies('1.3.0', '1.2.*')).toBe(false);
  });

  it('1.x.3 is treated as 1.x (x in minor)', () => {
    expect(satisfies('1.0.3', '1.x.3')).toBe(true);
    expect(satisfies('1.5.0', '1.x.3')).toBe(true);
    expect(satisfies('2.0.0', '1.x.3')).toBe(false);
  });
});

describe('satisfies - comparators', () => {
  it('>= matches greater or equal', () => {
    expect(satisfies('1.2.3', '>=1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '>=1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '>=1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '>=1.2.3')).toBe(false);
  });

  it('> matches strictly greater', () => {
    expect(satisfies('1.2.3', '>1.2.3')).toBe(false);
    expect(satisfies('1.2.4', '>1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '>1.2.3')).toBe(false);
  });

  it('<= matches less or equal', () => {
    expect(satisfies('1.2.3', '<=1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '<=1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '<=1.2.3')).toBe(false);
  });

  it('< matches strictly less', () => {
    expect(satisfies('1.2.3', '<1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '<1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '<1.2.3')).toBe(false);
  });

  it('comparator with prerelease allows prerelease only on same [major,minor,patch] tuple', () => {
    expect(satisfies('1.2.3-alpha', '>=1.2.3')).toBe(false);
    expect(satisfies('1.2.3-alpha', '>=1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.2-alpha', '>=1.2.3-alpha')).toBe(false);
    expect(satisfies('1.2.4-alpha', '>=1.2.3-alpha')).toBe(false);
  });
});

describe('satisfies - hyphen ranges', () => {
  it('1.0.0 - 2.0.0 means >=1.0.0 <=2.0.0', () => {
    expect(satisfies('1.0.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('0.9.9', '1.0.0 - 2.0.0')).toBe(false);
    expect(satisfies('2.0.1', '1.0.0 - 2.0.0')).toBe(false);
  });

  it('1.0.0 - 2.0.0 prerelease matching follows same-tuple rule', () => {
    expect(satisfies('1.5.0-alpha', '1.0.0 - 2.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha', '1.0.0-alpha - 2.0.0')).toBe(true);
    expect(satisfies('1.5.0-alpha', '1.0.0-alpha - 2.0.0')).toBe(false);
  });

  it('shorthand partial left side: 1.0 - 2.0.0 means >=1.0.0 <=2.0.0', () => {
    expect(satisfies('1.0.0', '1.0 - 2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '1.0 - 2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '1.0 - 2.0.0')).toBe(true);
  });
});

describe('satisfies - || unions', () => {
  it('matches either side', () => {
    expect(satisfies('1.0.0', '1.0.0 || 2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '1.0.0 || 2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '1.0.0 || 2.0.0')).toBe(false);
  });

  it('|| with ranges', () => {
    expect(satisfies('1.2.3', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('2.3.4', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
  });

  it('|| with prerelease: side with prerelease allows prerelease match', () => {
    expect(satisfies('1.2.3-alpha', '1.2.3-alpha || 2.0.0')).toBe(true);
    expect(satisfies('1.2.3-alpha', '^1.0.0 || 2.0.0')).toBe(false);
  });

  it('multiple ||', () => {
    expect(satisfies('1.0.0', '1.0.0 || 2.0.0 || 3.0.0')).toBe(true);
    expect(satisfies('2.0.0', '1.0.0 || 2.0.0 || 3.0.0')).toBe(true);
    expect(satisfies('4.0.0', '1.0.0 || 2.0.0 || 3.0.0')).toBe(false);
  });
});

describe('satisfies - combined comparators (AND)', () => {
  it('>=1.0.0 <2.0.0', () => {
    expect(satisfies('1.0.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfies('0.9.9', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('>1.0.0 <=1.5.0', () => {
    expect(satisfies('1.0.1', '>1.0.0 <=1.5.0')).toBe(true);
    expect(satisfies('1.0.0', '>1.0.0 <=1.5.0')).toBe(false);
    expect(satisfies('1.5.0', '>1.0.0 <=1.5.0')).toBe(true);
    expect(satisfies('1.5.1', '>1.0.0 <=1.5.0')).toBe(false);
  });
});

describe('satisfies - invalid inputs', () => {
  it('throws or returns false for invalid version', () => {
    expect(() => satisfies('bad', '>=1.0.0')).toThrow();
  });

  it('throws or returns false for invalid range', () => {
    expect(() => satisfies('1.0.0', 'not-a-range')).toThrow();
  });
});

describe('maxSatisfying', () => {
  it('returns the highest matching version', () => {
    const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'];
    expect(maxSatisfying(versions, '^1.0.0')).toBe('1.2.0');
  });

  it('returns null when no version matches', () => {
    expect(maxSatisfying(['1.0.0', '1.1.0'], '^2.0.0')).toBeNull();
  });

  it('returns exact match', () => {
    expect(maxSatisfying(['1.0.0', '2.0.0'], '1.0.0')).toBe('1.0.0');
  });

  it('handles prerelease correctly', () => {
    expect(maxSatisfying(['1.0.0-alpha', '1.0.0', '1.0.0-beta'], '^1.0.0')).toBe('1.0.0');
    expect(maxSatisfying(['1.0.0-alpha', '1.0.0-beta'], '^1.0.0')).toBeNull();
    expect(maxSatisfying(['1.0.0-alpha', '1.0.0-beta'], '^1.0.0-alpha')).toBe('1.0.0-beta');
  });

  it('handles empty array', () => {
    expect(maxSatisfying([], '^1.0.0')).toBeNull();
  });

  it('sorts correctly across major boundaries', () => {
    expect(maxSatisfying(['0.9.9', '1.0.0', '1.0.1'], '~1.0.0')).toBe('1.0.1');
  });

  it('ignores invalid versions in the list', () => {
    expect(maxSatisfying(['1.0.0', 'bad', '1.1.0'], '^1.0.0')).toBe('1.1.0');
  });
});

describe('compare / ordering edge cases', () => {
  it('numeric identifiers compare numerically', () => {
    expect(satisfies('1.2.10', '>1.2.9')).toBe(true);
    expect(satisfies('1.2.9', '>1.2.10')).toBe(false);
  });

  it('prerelease is less than release', () => {
    // npm-faithful: a prerelease version is only matched when the range
    // explicitly references a prerelease (exact/prerelease-aware comparator)
    expect(satisfies('1.0.0-alpha', '<1.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha', '>1.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha', '<=1.0.0-alpha')).toBe(true);
    expect(satisfies('1.0.0-alpha', '>=1.0.0-alpha')).toBe(true);
    expect(satisfies('1.0.0-alpha', '<1.0.0-alpha')).toBe(false); // equal, not less
    expect(satisfies('1.0.0-alpha', '>1.0.0-alpha')).toBe(false); // equal, not greater
  });

  it('prerelease parts compare lexicographically vs numerically', () => {
    expect(satisfies('1.0.0-alpha', '<1.0.0-beta')).toBe(true);
    expect(satisfies('1.0.0-1', '<1.0.0-2')).toBe(true);
    expect(satisfies('1.0.0-1', '<1.0.0-alpha')).toBe(true); // numeric < alphanumeric
  });

  it('build metadata does not affect comparison', () => {
    expect(satisfies('1.0.0+build1', '1.0.0')).toBe(true);
    expect(satisfies('1.0.0+build1', '1.0.0+build2')).toBe(true);
    expect(satisfies('1.0.0+build2', '1.0.0+build1')).toBe(true);
  });
});

describe('prerelease admission requires same [major,minor,patch] tuple (fix 1)', () => {
  it('compound range admits same-tuple prerelease, rejects cross-tuple', () => {
    expect(satisfies('1.2.3-beta', '>=1.2.3-alpha <2.0.0')).toBe(true);
    expect(satisfies('1.5.0-beta', '>=1.2.3-alpha <2.0.0')).toBe(false);
    expect(satisfies('3.0.0-x', '>=1.2.3-alpha <2.0.0')).toBe(false);
  });

  it('caret-prerelease admits same-tuple prerelease only', () => {
    expect(satisfies('1.2.3-alpha', '^1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.3-beta', '^1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.4-alpha', '^1.2.3-alpha')).toBe(false);
    expect(satisfies('1.3.0-alpha', '^1.2.3-alpha')).toBe(false);
  });

  it('release versions still bypass the prerelease tuple rule', () => {
    expect(satisfies('1.2.4', '>=1.2.3-alpha <2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '>=1.2.3-alpha <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.2.3-alpha <2.0.0')).toBe(false);
  });

  it('* still admits prereleases regardless of tuple', () => {
    expect(satisfies('1.2.3-alpha', '*')).toBe(true);
    expect(satisfies('99.99.99-rc.0', '*')).toBe(true);
  });
});

describe('tilde preserves prerelease lower bound (fix 2)', () => {
  it('~1.2.3-alpha expands to >=1.2.3-alpha <1.3.0', () => {
    expect(satisfies('1.2.3-alpha', '~1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.3-beta', '~1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.4', '~1.2.3-alpha')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3-alpha')).toBe(false);
    expect(satisfies('1.2.0', '~1.2.3-alpha')).toBe(false);
    expect(satisfies('1.2.3-0', '~1.2.3-alpha')).toBe(false); // 0 < alpha (numeric < alphanumeric)
  });

  it('plain ~1.2.3 still expands to >=1.2.3 <1.3.0', () => {
    expect(satisfies('1.2.3', '~1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '~1.2.3')).toBe(false);
  });

  it('~0.2.3-beta preserves prerelease lower bound', () => {
    expect(satisfies('0.2.3-beta', '~0.2.3-beta')).toBe(true);
    expect(satisfies('0.2.3-rc', '~0.2.3-beta')).toBe(true);
    expect(satisfies('0.2.3-alpha', '~0.2.3-beta')).toBe(false);
    expect(satisfies('0.3.0', '~0.2.3-beta')).toBe(false);
  });
});

describe('prerelease identifier ordering (fix 3)', () => {
  it('shorter identifier list has lower precedence when prefix is equal', () => {
    expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compare('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
    expect(comparePrerelease(['alpha'], ['alpha', '1'])).toBe(-1);
    expect(comparePrerelease(['alpha', '1'], ['alpha'])).toBe(1);
  });

  it('numeric identifiers compare numerically', () => {
    expect(compare('1.0.0-1', '1.0.0-2')).toBe(-1);
    expect(compare('1.0.0-2', '1.0.0-10')).toBe(-1);
    expect(compare('1.0.0-10', '1.0.0-2')).toBe(1);
  });

  it('alphanumeric identifiers compare lexically', () => {
    expect(compare('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compare('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compare('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1);
  });

  it('numeric < alphanumeric when same position', () => {
    expect(compare('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compare('1.0.0-alpha', '1.0.0-1')).toBe(1);
  });

  it('full chain alpha < alpha.1 < alpha.beta < beta < release', () => {
    expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compare('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compare('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1);
    expect(compare('1.0.0-beta', '1.0.0')).toBe(-1);
  });

  it('satisfies expresses the shorter-list rule for same-tuple prerelease ranges', () => {
    expect(satisfies('1.0.0-alpha', '<1.0.0-alpha.1')).toBe(true);
    expect(satisfies('1.0.0-alpha.1', '>1.0.0-alpha')).toBe(true);
  });
});

describe('wildcard comparators with operators (fix 4)', () => {
  it('<=1.x expands to <2.0.0', () => {
    expect(satisfies('1.9.9', '<=1.x')).toBe(true);
    expect(satisfies('1.0.0', '<=1.x')).toBe(true);
    expect(satisfies('2.0.0', '<=1.x')).toBe(false);
  });

  it('<1.x expands to <1.0.0', () => {
    expect(satisfies('0.9.9', '<1.x')).toBe(true);
    expect(satisfies('1.0.0', '<1.x')).toBe(false);
  });

  it('>1.x expands to >=2.0.0', () => {
    expect(satisfies('2.0.0', '>1.x')).toBe(true);
    expect(satisfies('1.9.9', '>1.x')).toBe(false);
  });

  it('>=1.x expands to >=1.0.0', () => {
    expect(satisfies('1.0.0', '>=1.x')).toBe(true);
    expect(satisfies('0.9.9', '>=1.x')).toBe(false);
  });

  it('<=1.2.x expands to <1.3.0', () => {
    expect(satisfies('1.2.9', '<=1.2.x')).toBe(true);
    expect(satisfies('1.3.0', '<=1.2.x')).toBe(false);
  });

  it('>1.2.x expands to >=1.3.0', () => {
    expect(satisfies('1.3.0', '>1.2.x')).toBe(true);
    expect(satisfies('1.2.9', '>1.2.x')).toBe(false);
  });

  it('<1.2.x expands to <1.2.0', () => {
    expect(satisfies('1.1.9', '<1.2.x')).toBe(true);
    expect(satisfies('1.2.0', '<1.2.x')).toBe(false);
  });

  it('>=1.2.x expands to >=1.2.0', () => {
    expect(satisfies('1.2.0', '>=1.2.x')).toBe(true);
    expect(satisfies('1.1.9', '>=1.2.x')).toBe(false);
  });
});

describe('parse() rejects partial versions (fix 5)', () => {
  it('rejects bare major', () => {
    expect(() => parse('1')).toThrow();
  });

  it('rejects major.minor', () => {
    expect(() => parse('1.2')).toThrow();
  });

  it('accepts full major.minor.patch', () => {
    const v = parse('1.2.3');
    expect(v.major).toBe(1);
    expect(v.minor).toBe(2);
    expect(v.patch).toBe(3);
  });

  it('accepts prerelease and build forms', () => {
    expect(parse('1.2.3-beta').prerelease).toEqual(['beta']);
    expect(parse('1.2.3+build').build).toEqual(['build']);
    expect(parse('1.2.3-rc.1+sha.abc').prerelease).toEqual(['rc', '1']);
  });

  it('does not produce NaN fields for any accepted version', () => {
    const v = parse('1.2.3');
    expect(Number.isNaN(v.major)).toBe(false);
    expect(Number.isNaN(v.minor)).toBe(false);
    expect(Number.isNaN(v.patch)).toBe(false);
  });

  it('x-ranges still parse and satisfy via range parsing', () => {
    expect(satisfies('1.5.0', '1.x')).toBe(true);
    expect(satisfies('1.5.0', '1.5.x')).toBe(true);
    expect(satisfies('1.5.0', '*')).toBe(true);
  });

  it('caret/tilde partials still work via range parsing', () => {
    expect(satisfies('1.5.0', '^1')).toBe(true);
    expect(satisfies('1.5.0', '^1.5')).toBe(true);
    expect(satisfies('2.0.0', '^1')).toBe(false);
    expect(satisfies('1.5.9', '~1.5')).toBe(true);
    expect(satisfies('1.6.0', '~1.5')).toBe(false);
    expect(satisfies('1.9.9', '~1')).toBe(true);
    expect(satisfies('2.0.0', '~1')).toBe(false);
  });

  it('hyphen-range partial sides still work', () => {
    expect(satisfies('1.5.0', '1.0 - 2.0.0')).toBe(true);
    expect(satisfies('2.0.1', '1.0 - 2.0.0')).toBe(false);
  });
});
