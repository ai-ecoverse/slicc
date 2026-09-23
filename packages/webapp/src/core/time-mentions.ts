export interface TimeMentionOccurrence {
  start: string;
  end?: string;
  allDay: boolean;
  open?: 'start' | 'end';
}

export interface TimeMention {
  start: number;
  end: number;
  text: string;
  confidence: number;
  occurrences: TimeMentionOccurrence[];
  rrules: string[];
}

export interface TimeContext {
  reference: string;
  timeZone: string;
}

interface ParserSpan {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

interface ParserResult {
  occurrences: TimeMentionOccurrence[];
  rrules: string[];
  spans: ParserSpan[];
}

export interface TimeParser {
  parseMany(texts: string[], context: TimeContext): Promise<ParserResult[]>;
}

export const MIN_CONFIDENCE = 0.8;

const SPLIT_CONFIDENCE = 0.4;

const SPLIT_MIN_WORDS = 6;

const MAX_OCCURRENCES = 8;

const MAX_TEXT_CHARS = 2000;

const TIME_HINT_RE =
  /\d|\b(?:today|tonight|tomorrow|yesterday|noon|midnight|morning|afternoon|evening|night|week|weekend|weekday|fortnight|month|year|day|days|hour|hours|minute|minutes|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*|\b(?:christmas|halloween|thanksgiving|daily|weekly|monthly|yearly|every)\b/i;

const FILLER = new Set([
  'now',
  'right now',
  'currently',
  'then',
  'soon',
  'later',
  'earlier',
  'recently',
  'once',
  'first',
  'second',
  'today',
  'day',
  'a day',
  'the day',
]);

const CLAUSE_SPLIT_RE = /([.!?;:])\s+|\n+|,\s+(?=(?:and|but|then|so|while|or)\b)/gi;
const CONJUNCTION_RE = /\s+(?:and|but|then|so|or)\s+/gi;

export function mayContainTime(text: string): boolean {
  return text.length >= 3 && TIME_HINT_RE.test(text);
}

export function splitClauses(text: string): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  let last = 0;
  const push = (from: number, to: number): void => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ offset: from + lead, text: trimmed });
  };
  for (const match of text.matchAll(CLAUSE_SPLIT_RE)) {
    const index = match.index ?? 0;

    push(last, match[1] ? index + 1 : index);
    last = index + match[0].length;
  }
  push(last, text.length);
  return out;
}

function splitConjunctions(text: string): Array<{ offset: number; text: string }> {
  const parts: Array<{ offset: number; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(CONJUNCTION_RE)) {
    const index = match.index ?? 0;
    parts.push({ offset: last, text: text.slice(last, index) });
    last = index + match[0].length;
  }
  parts.push({ offset: last, text: text.slice(last) });
  return parts.filter((part) => part.text.trim().length > 0);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

export function isMeaningfulSpan(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '');
  if (normalized.length < 3) return false;
  if (FILLER.has(normalized)) return false;

  if (/^\d+$/.test(normalized)) return false;
  return true;
}

interface Candidate {
  textIndex: number;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export async function findTimeMentions(
  texts: readonly string[],
  context: TimeContext,
  parser: TimeParser
): Promise<TimeMention[][]> {
  const results: TimeMention[][] = texts.map(() => []);

  const clauses: Array<{ textIndex: number; offset: number; text: string }> = [];
  texts.forEach((text, textIndex) => {
    if (!mayContainTime(text)) return;
    for (const clause of splitClauses(text.slice(0, MAX_TEXT_CHARS))) {
      if (mayContainTime(clause.text)) clauses.push({ textIndex, ...clause });
    }
  });
  if (clauses.length === 0) return results;
  const clauseResults = await parser.parseMany(
    clauses.map((c) => c.text),
    context
  );

  const candidates: Candidate[] = [];
  const toSplit: Array<{ base: Candidate; parts: Array<{ offset: number; text: string }> }> = [];
  clauseResults.forEach((result, i) => {
    const clause = clauses[i];
    if (!clause) return;
    for (const span of result.spans) {
      const candidate: Candidate = {
        textIndex: clause.textIndex,
        start: clause.offset + span.start,
        end: clause.offset + span.end,
        text: span.text,
        confidence: span.confidence,
      };
      const parts = splitConjunctions(span.text);
      if (
        parts.length > 1 &&
        wordCount(span.text) > SPLIT_MIN_WORDS &&
        span.confidence >= SPLIT_CONFIDENCE
      ) {
        toSplit.push({ base: candidate, parts });
      } else if (span.confidence >= MIN_CONFIDENCE && isMeaningfulSpan(span.text)) {
        candidates.push(candidate);
      }
    }
  });

  if (toSplit.length > 0) {
    const flat = toSplit.flatMap(({ base, parts }) => parts.map((part) => ({ base, part })));
    const partResults = await parser.parseMany(
      flat.map(({ part }) => part.text),
      context
    );
    partResults.forEach((result, i) => {
      const entry = flat[i];
      if (!entry) return;
      for (const span of result.spans) {
        if (span.confidence < MIN_CONFIDENCE || !isMeaningfulSpan(span.text)) continue;
        const start = entry.base.start + entry.part.offset + span.start;
        candidates.push({
          textIndex: entry.base.textIndex,
          start,
          end: start + (span.end - span.start),
          text: span.text,
          confidence: span.confidence,
        });
      }
    });
  }
  if (candidates.length === 0) return results;

  const resolved = await parser.parseMany(
    candidates.map((c) => c.text),
    context
  );
  resolved.forEach((result, i) => {
    const candidate = candidates[i];
    if (!candidate || result.occurrences.length === 0) return;
    results[candidate.textIndex]?.push({
      start: candidate.start,
      end: candidate.end,
      text: candidate.text,
      confidence: candidate.confidence,
      occurrences: result.occurrences.slice(0, MAX_OCCURRENCES).map((occ) => ({
        start: occ.start,
        ...(occ.end ? { end: occ.end } : {}),
        allDay: occ.allDay,
        ...(occ.open ? { open: occ.open } : {}),
      })),
      rrules: [...result.rrules],
    });
  });

  for (const list of results) {
    list.sort((a, b) => a.start - b.start);

    for (let i = list.length - 1; i > 0; i -= 1) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev && cur && cur.start < prev.end) list.splice(i, 1);
    }
  }
  return results;
}

let parserPromise: Promise<TimeParser> | null = null;

export function loadTimeParser(): Promise<TimeParser> {
  parserPromise ??= import('gpu-time')
    .then(({ defineParser }) => defineParser({ backend: 'cpu' }))
    .then(
      (parser): TimeParser => ({
        parseMany: (texts, context) => parser.parseMany(texts, context),
      })
    )
    .catch((err: unknown) => {
      parserPromise = null;
      throw err;
    });
  return parserPromise;
}

export function currentTimeContext(now: Date = new Date()): TimeContext {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { reference: now.toISOString(), timeZone };
}
