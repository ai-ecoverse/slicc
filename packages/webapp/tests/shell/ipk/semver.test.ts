import { describe, expect, it } from 'vitest';
import { isValidRange, maxSatisfying, satisfies } from '../../../src/shell/ipk/semver.js';

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
  it('* matches any release but no prereleases (node-semver default)', () => {
    expect(satisfies('0.0.0', '*')).toBe(true);
    expect(satisfies('99.99.99', '*')).toBe(true);
    expect(satisfies('1.2.3-alpha', '*')).toBe(false);
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

  it('1.x.3 (a fixed patch under a wildcard minor) is an invalid range', () => {
    // node-semver rejects a concrete identifier to the right of a wildcard,
    // so the range never parses and nothing satisfies it.
    expect(isValidRange('1.x.3')).toBe(false);
    expect(satisfies('1.0.3', '1.x.3')).toBe(false);
    expect(satisfies('1.5.0', '1.x.3')).toBe(false);
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

  it('comparator with prerelease allows prerelease only on same tuple', () => {
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

  it('hyphen prerelease matching follows same-tuple rule', () => {
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

describe('satisfies - invalid inputs return false (never throw)', () => {
  it('returns false for an invalid version', () => {
    expect(satisfies('bad', '>=1.0.0')).toBe(false);
  });

  it('returns false for an invalid range', () => {
    expect(satisfies('1.0.0', 'not-a-range')).toBe(false);
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

  it('returns null for an invalid range', () => {
    expect(maxSatisfying(['1.0.0', '1.1.0'], 'not-a-range')).toBeNull();
  });
});

describe('isValidRange', () => {
  it('is truthy for valid ranges', () => {
    expect(isValidRange('^1.2.3')).toBe(true);
    expect(isValidRange('~1.2')).toBe(true);
    expect(isValidRange('1.x')).toBe(true);
    expect(isValidRange('*')).toBe(true);
    expect(isValidRange('>=1.0.0 <2.0.0')).toBe(true);
    expect(isValidRange('1.0.0 - 2.0.0')).toBe(true);
    expect(isValidRange('^1.0.0 || ^2.0.0')).toBe(true);
  });

  it('is false for invalid ranges', () => {
    expect(isValidRange('not-a-range')).toBe(false);
    expect(isValidRange('@@@')).toBe(false);
  });

  it('never throws', () => {
    expect(() => isValidRange('garbage-input')).not.toThrow();
  });
});

describe('satisfies - ordering edge cases', () => {
  it('numeric identifiers compare numerically', () => {
    expect(satisfies('1.2.10', '>1.2.9')).toBe(true);
    expect(satisfies('1.2.9', '>1.2.10')).toBe(false);
  });

  it('prerelease is less than release', () => {
    expect(satisfies('1.0.0-alpha', '<1.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha', '>1.0.0')).toBe(false);
    expect(satisfies('1.0.0-alpha', '<=1.0.0-alpha')).toBe(true);
    expect(satisfies('1.0.0-alpha', '>=1.0.0-alpha')).toBe(true);
    expect(satisfies('1.0.0-alpha', '<1.0.0-alpha')).toBe(false);
    expect(satisfies('1.0.0-alpha', '>1.0.0-alpha')).toBe(false);
  });

  it('prerelease parts compare lexically vs numerically', () => {
    expect(satisfies('1.0.0-alpha', '<1.0.0-beta')).toBe(true);
    expect(satisfies('1.0.0-1', '<1.0.0-2')).toBe(true);
    expect(satisfies('1.0.0-1', '<1.0.0-alpha')).toBe(true);
  });

  it('build metadata does not affect comparison', () => {
    expect(satisfies('1.0.0+build1', '1.0.0')).toBe(true);
    expect(satisfies('1.0.0+build1', '1.0.0+build2')).toBe(true);
    expect(satisfies('1.0.0+build2', '1.0.0+build1')).toBe(true);
  });

  it('shorter prerelease list has lower precedence (same prefix)', () => {
    expect(satisfies('1.0.0-alpha', '<1.0.0-alpha.1')).toBe(true);
    expect(satisfies('1.0.0-alpha.1', '>1.0.0-alpha')).toBe(true);
  });
});

describe('prerelease admission requires same [major,minor,patch] tuple', () => {
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

  it('wildcard ranges do NOT admit prereleases (includePrerelease=false)', () => {
    expect(satisfies('1.0.0-alpha', '*')).toBe(false);
    expect(satisfies('99.99.99-rc.0', '*')).toBe(false);
    expect(satisfies('1.2.3-alpha', '1.x')).toBe(false);
    expect(satisfies('1.2.3-alpha', '1.2.x')).toBe(false);
  });
});

describe('tilde preserves prerelease lower bound', () => {
  it('~1.2.3-alpha expands to >=1.2.3-alpha <1.3.0', () => {
    expect(satisfies('1.2.3-alpha', '~1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.3-beta', '~1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.4', '~1.2.3-alpha')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3-alpha')).toBe(false);
    expect(satisfies('1.2.0', '~1.2.3-alpha')).toBe(false);
    expect(satisfies('1.2.3-0', '~1.2.3-alpha')).toBe(false);
  });

  it('~0.2.3-beta preserves prerelease lower bound', () => {
    expect(satisfies('0.2.3-beta', '~0.2.3-beta')).toBe(true);
    expect(satisfies('0.2.3-rc', '~0.2.3-beta')).toBe(true);
    expect(satisfies('0.2.3-alpha', '~0.2.3-beta')).toBe(false);
    expect(satisfies('0.3.0', '~0.2.3-beta')).toBe(false);
  });
});

describe('wildcard comparators with operators', () => {
  it('<=1.x expands to <2.0.0', () => {
    expect(satisfies('1.9.9', '<=1.x')).toBe(true);
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
});

describe('bare wildcard operands with operators (node-semver replaceXRange)', () => {
  it('strict >* and <* match NOTHING', () => {
    expect(satisfies('1.2.3', '>*')).toBe(false);
    expect(satisfies('1.2.3', '<*')).toBe(false);
    expect(satisfies('1.2.3-alpha', '>*')).toBe(false);
  });

  it('>=* and <=* match ANY release version', () => {
    expect(satisfies('0.0.0', '>=*')).toBe(true);
    expect(satisfies('99.99.99', '<=*')).toBe(true);
  });

  it('=* matches ANY release version', () => {
    expect(satisfies('1.2.3', '=*')).toBe(true);
  });

  it('bare wildcard operands do NOT admit prereleases', () => {
    expect(satisfies('1.2.3-alpha', '>=*')).toBe(false);
    expect(satisfies('1.2.3-alpha', '=*')).toBe(false);
  });
});

describe('partial ranges still resolve via range parsing', () => {
  it('x-ranges parse and satisfy', () => {
    expect(satisfies('1.5.0', '1.x')).toBe(true);
    expect(satisfies('1.5.0', '1.5.x')).toBe(true);
    expect(satisfies('1.5.0', '*')).toBe(true);
  });

  it('caret/tilde partials work', () => {
    expect(satisfies('1.5.0', '^1')).toBe(true);
    expect(satisfies('1.5.0', '^1.5')).toBe(true);
    expect(satisfies('2.0.0', '^1')).toBe(false);
    expect(satisfies('1.5.9', '~1.5')).toBe(true);
    expect(satisfies('1.6.0', '~1.5')).toBe(false);
    expect(satisfies('1.9.9', '~1')).toBe(true);
    expect(satisfies('2.0.0', '~1')).toBe(false);
  });

  it('hyphen-range partial sides work', () => {
    expect(satisfies('1.5.0', '1.0 - 2.0.0')).toBe(true);
    expect(satisfies('2.0.1', '1.0 - 2.0.0')).toBe(false);
  });
});
