import { describe, expect, it } from 'vitest';
import {
  currentTimeContext,
  findTimeMentions,
  isMeaningfulSpan,
  loadTimeParser,
  mayContainTime,
  splitClauses,
  type TimeParser,
} from '../../src/core/time-mentions.js';

const CONTEXT = { reference: '2026-09-23T10:00:00.000Z', timeZone: 'Europe/Berlin' };

function scriptedParser(
  phrases: Record<string, { confidence?: number; occurrences?: number; rrule?: string }>
): TimeParser & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    parseMany: async (texts) => {
      calls.push([...texts]);
      return texts.map((text) => {
        const spans: Array<{ start: number; end: number; text: string; confidence: number }> = [];
        for (const [phrase, cfg] of Object.entries(phrases)) {
          const at = text.indexOf(phrase);
          if (at < 0) continue;
          spans.push({
            start: at,
            end: at + phrase.length,
            text: phrase,
            confidence: cfg.confidence ?? 0.99,
          });
        }
        const alone = phrases[text];
        const occurrences = alone
          ? Array.from({ length: alone.occurrences ?? 1 }, (_, i) => ({
              start: `2026-09-2${4 + i}T09:00:00+02:00`,
              allDay: false,
            }))
          : [];
        return { spans, occurrences, rrules: alone?.rrule ? [alone.rrule] : [] };
      });
    },
  };
}

describe('mayContainTime', () => {
  it('screens out text with no time words', () => {
    expect(mayContainTime('I rewrote the watcher module')).toBe(false);
    expect(mayContainTime('tomorrow')).toBe(true);
    expect(mayContainTime('at 9')).toBe(true);
    expect(mayContainTime('ok')).toBe(false);
  });
});

describe('splitClauses', () => {
  it('splits sentences and comma-conjunctions, keeping offsets', () => {
    const text = 'Standup is daily. Retro is monthly, and demo is weekly';
    const clauses = splitClauses(text);
    expect(clauses.map((c) => c.text)).toEqual([
      'Standup is daily.',
      'Retro is monthly',
      'and demo is weekly',
    ]);
    for (const c of clauses) expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
  });
});

describe('isMeaningfulSpan', () => {
  it('drops filler and bare numbers', () => {
    expect(isMeaningfulSpan('Now')).toBe(false);
    expect(isMeaningfulSpan('2024')).toBe(false);
    expect(isMeaningfulSpan('at')).toBe(false);
    expect(isMeaningfulSpan('tomorrow at 9am')).toBe(true);
  });
});

describe('findTimeMentions (scripted parser)', () => {
  it('maps spans back to offsets in the original text and resolves each alone', async () => {
    const parser = scriptedParser({ 'tomorrow at 9am': { occurrences: 1 } });
    const text = 'Ship it. I will run it tomorrow at 9am.';
    const [mentions] = await findTimeMentions([text], CONTEXT, parser);
    expect(mentions).toHaveLength(1);
    const m = mentions?.[0];
    expect(text.slice(m?.start, m?.end)).toBe('tomorrow at 9am');
    expect(m?.occurrences).toEqual([{ start: '2026-09-24T09:00:00+02:00', allDay: false }]);
  });

  it('drops low-confidence and filler spans', async () => {
    const parser = scriptedParser({ 'next week': { confidence: 0.5 }, Now: {} });
    const [mentions] = await findTimeMentions(['Now we wait until next week'], CONTEXT, parser);
    expect(mentions).toEqual([]);
  });

  it('re-parses a merged span part by part', async () => {
    const merged = 'tomorrow at 9am and check back in 20 minutes';
    const parser = scriptedParser({
      [merged]: { confidence: 0.69 },
      'tomorrow at 9am': {},
      'in 20 minutes': {},
    });
    const text = `I'll run it ${merged}.`;
    const [mentions] = await findTimeMentions([text], CONTEXT, parser);
    expect(mentions?.map((m) => text.slice(m.start, m.end))).toEqual([
      'tomorrow at 9am',
      'in 20 minutes',
    ]);
  });

  it('drops spans that resolve to nothing on their own', async () => {
    const noResolve: TimeParser = {
      parseMany: async (texts) =>
        texts.map((t) => {
          const at = t.indexOf('weekday');
          return {
            spans: at >= 0 ? [{ start: at, end: at + 7, text: 'weekday', confidence: 0.95 }] : [],
            occurrences: [],
            rrules: [],
          };
        }),
    };
    expect(await findTimeMentions(['on a weekday'], CONTEXT, noResolve)).toEqual([[]]);
  });

  it('never calls the parser for text without time words', async () => {
    const parser = scriptedParser({});
    expect(await findTimeMentions(['plain words', 'more words'], CONTEXT, parser)).toEqual([
      [],
      [],
    ]);
    expect(parser.calls).toEqual([]);
  });

  it('keeps recurrence rules and caps occurrences', async () => {
    const parser = scriptedParser({
      'every weekday': { occurrences: 5, rrule: 'RRULE:FREQ=WEEKLY' },
    });
    const [mentions] = await findTimeMentions(['standup every weekday'], CONTEXT, parser);
    expect(mentions?.[0]?.rrules).toEqual(['RRULE:FREQ=WEEKLY']);
    expect(mentions?.[0]?.occurrences).toHaveLength(5);
  });
});

describe('currentTimeContext', () => {
  it('uses the given instant and a real zone', () => {
    const ctx = currentTimeContext(new Date('2026-01-02T03:04:05Z'));
    expect(ctx.reference).toBe('2026-01-02T03:04:05.000Z');
    expect(ctx.timeZone.length).toBeGreaterThan(0);
  });
});

describe('findTimeMentions (gpu-time)', () => {
  it('finds, splits and filters on real prose', async () => {
    const parser = await loadTimeParser();
    const texts = [
      "I'll run the migration tomorrow at 9am and check back in 20 minutes.",
      'Deploy window: Friday 10pm until Saturday 2am.',
      'Now the tests pass, and I bumped the version to 1.2.3 in package.json.',
      'Should I file an issue next?',
    ];
    const found = await findTimeMentions(texts, CONTEXT, parser);
    const spans = found.map((list, i) => list.map((m) => texts[i]?.slice(m.start, m.end)));
    expect(spans[0]).toEqual(['tomorrow at 9am', 'in 20 minutes']);
    expect(spans[1]).toEqual(['Friday 10pm until Saturday 2am']);
    expect(spans[2]).toEqual([]);
    expect(spans[3]).toEqual([]);
    expect(found[1]?.[0]?.occurrences[0]).toMatchObject({
      start: '2026-09-25T22:00:00+02:00',
      end: '2026-09-26T02:00:00+02:00',
    });
  });

  it('loads the parser once', async () => {
    expect(await loadTimeParser()).toBe(await loadTimeParser());
  });
});
