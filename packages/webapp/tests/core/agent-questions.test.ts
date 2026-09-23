import { describe, expect, it } from 'vitest';
import {
  classifyQuestion,
  findAgentQuestions,
  splitSentences,
} from '../../src/core/agent-questions.js';

describe('classifyQuestion', () => {
  it.each([
    ['Should I file an issue next?', 'yes-no'],
    ['So, should I push the branch?', 'yes-no'],
    ['Want me to open a PR?', 'yes-no'],
    ["Don't you want tests too?", 'yes-no'],
    ['Do you want A or B?', 'text'],
    ['Should I keep it, or not?', 'yes-no'],
    ['When should the migration run?', 'datetime'],
    ['What time works for the call?', 'datetime'],
    ['What date is the release?', 'date'],
    ['How many retries should it allow?', 'number'],
    ['What is your email address?', 'email'],
    ['Where should I put the file?', 'text'],
    ['Which branch should I target?', 'text'],
    ['Why did the build fail?', 'text'],
  ])('%s → %s', (sentence, kind) => {
    expect(classifyQuestion(sentence)).toBe(kind);
  });

  it('rejects statements and non-direct questions', () => {
    expect(classifyQuestion('I filed the issue.')).toBeNull();
    expect(classifyQuestion('Let me know if that works?')).toBeNull();
    expect(classifyQuestion('Should I')).toBeNull();
  });
});

describe('splitSentences', () => {
  it('keeps dots inside file names and versions', () => {
    expect(
      splitSentences('I bumped v1.2 in check.js. Should I rewrite check.js?').map((s) => s.text)
    ).toEqual(['I bumped v1.2 in check.js.', 'Should I rewrite check.js?']);
  });

  it('breaks on newlines', () => {
    expect(splitSentences('Done\nShould I continue?').map((s) => s.text)).toEqual([
      'Done',
      'Should I continue?',
    ]);
  });
});

describe('findAgentQuestions', () => {
  it('returns each question with its offsets and kind', () => {
    const text = 'I fixed the test. Should I file an issue next? When should it ship?';
    const found = findAgentQuestions(text);
    expect(found.map((q) => [q.text, q.kind])).toEqual([
      ['Should I file an issue next?', 'yes-no'],
      ['When should it ship?', 'datetime'],
    ]);
    for (const q of found) expect(text.slice(q.start, q.end)).toBe(q.text);
  });

  it('finds nothing in plain prose', () => {
    expect(findAgentQuestions('All done. The build is green.')).toEqual([]);
  });
});
