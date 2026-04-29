import { describe, it, expect } from 'vitest';
import {
  buildGreeting,
  buildCapabilityLine,
  buildConfession,
  buildIntroMessages,
  __test__,
} from '../../src/scoops/onboarding-messages.js';

/** Deterministic random — returns each value in `seq` in order, then 0. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i] ?? 0;
    i++;
    return v;
  };
}

describe('onboarding-messages', () => {
  describe('buildGreeting', () => {
    it('uses a named greeting when name is provided', () => {
      const out = buildGreeting({ name: 'Paolo' }, () => 0);
      expect(out).toContain('Paolo');
      // First named-greeting stub should be picked when rand=0.
      expect(out.startsWith(__test__.NAMED_GREETINGS[0]('Paolo'))).toBe(true);
    });

    it('uses an anonymous-friendly greeting when name is empty', () => {
      const out = buildGreeting({ name: '' }, () => 0);
      expect(out).toContain(__test__.ANON_GREETINGS[0]);
      expect(out.toLowerCase()).not.toContain('undefined');
    });

    it('treats whitespace-only names as anonymous', () => {
      const out = buildGreeting({ name: '   ' }, () => 0);
      expect(out).toContain(__test__.ANON_GREETINGS[0]);
    });

    it('appends a purpose riff when purpose is recognised', () => {
      const out = buildGreeting({ name: 'Lars', purpose: 'work' }, () => 0);
      expect(out).toContain(__test__.PURPOSE_RIFFS.work[0]);
    });

    it('skips the purpose riff for unknown purposes', () => {
      const out = buildGreeting({ name: 'Lars', purpose: 'mystery' }, () => 0);
      expect(out).toBe(__test__.NAMED_GREETINGS[0]('Lars'));
    });

    it('reminds anonymous users they can change their mind', () => {
      const lines = __test__.ANON_GREETINGS.join(' ');
      // The whole anon stub bag should signal optional disclosure.
      expect(/(later|change your mind|word|cloak|incognito)/i.test(lines)).toBe(true);
    });
  });

  describe('buildCapabilityLine', () => {
    it('uses a role pitch + identity assertion', () => {
      const out = buildCapabilityLine({ role: 'developer' }, () => 0);
      expect(out.startsWith("I'm sliccy.")).toBe(true);
      expect(out).toContain(__test__.ROLE_PITCHES.developer[0]);
      expect(out).toContain("I'm an AI agent.");
    });

    it('falls back to the default pitch for unknown roles', () => {
      const out = buildCapabilityLine({ role: 'scribe' }, () => 0);
      expect(out).toContain(__test__.ROLE_PITCH_DEFAULT[0]);
    });

    it('mentions up to three humanised task ids', () => {
      const out = buildCapabilityLine(
        { role: 'developer', tasks: ['build-websites', 'automate', 'research', 'extract-data'] },
        () => 0
      );
      expect(out).toContain('build websites');
      expect(out).toContain('automate');
      expect(out).toContain('research');
      // Truncated at three.
      expect(out).not.toContain('extract data');
    });

    it('omits the task clause when tasks are empty', () => {
      const out = buildCapabilityLine({ role: 'developer', tasks: [] }, () => 0);
      expect(out).not.toContain('Especially handy');
    });
  });

  describe('buildConfession', () => {
    it('always confesses to needing a model', () => {
      for (const stub of __test__.CONFESSIONS) {
        expect(/model|brain|provider|LLM|empty shell|placeholder/i.test(stub)).toBe(true);
      }
    });

    it('picks deterministically from the stub bag', () => {
      // rand=0 → first stub.
      expect(buildConfession({}, () => 0)).toBe(__test__.CONFESSIONS[0]);
    });
  });

  describe('buildIntroMessages', () => {
    it('returns exactly 3 lines in greet/capability/confession order', () => {
      const lines = buildIntroMessages(
        { name: 'Marlene', purpose: 'work', role: 'designer', tasks: ['build-websites'] },
        seq([0, 0, 0, 0, 0, 0])
      );
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('Marlene');
      expect(lines[1].startsWith("I'm sliccy.")).toBe(true);
      expect(lines[2]).toBe(__test__.CONFESSIONS[0]);
    });

    it('handles an entirely empty profile without throwing', () => {
      const lines = buildIntroMessages({}, () => 0.5);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0);
        expect(line.toLowerCase()).not.toContain('undefined');
      }
    });
  });

  describe('helpers', () => {
    it('humanises hyphenated task ids', () => {
      expect(__test__.humaniseTask('build-websites')).toBe('build websites');
      expect(__test__.humaniseTask('seo')).toBe('seo');
    });

    it('formats Oxford-comma lists', () => {
      expect(__test__.listSentence([])).toBe('');
      expect(__test__.listSentence(['a'])).toBe('a');
      expect(__test__.listSentence(['a', 'b'])).toBe('a and b');
      expect(__test__.listSentence(['a', 'b', 'c'])).toBe('a, b, and c');
    });
  });
});
