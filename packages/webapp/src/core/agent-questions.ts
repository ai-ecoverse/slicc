/**
 * Finding the questions an agent asks in prose, and what kind of answer each
 * one wants.
 *
 * Agents end turns with questions — "Should I file an issue next?", "When
 * should the migration run?" — and the only way to answer today is to type.
 * This finds those sentences so the transcript can offer the answer inline:
 * Yes/No for a yes/no question, an input fitted to the question word for the
 * rest.
 *
 * Detection is sentence-level and deliberately conservative: a sentence must
 * END with `?` and START with a word that makes it a direct question. Rhetorical
 * or quoted questions inside longer sentences are left alone, and a question
 * that fits no known shape is still offered as free text rather than guessed at.
 */

/** Which control a question gets. Mirrors `QuestionKind` in `@slicc/webcomponents`. */
export type AgentQuestionKind = 'yes-no' | 'text' | 'number' | 'datetime' | 'date' | 'email';

/** A question found in a text. */
export interface AgentQuestion {
  start: number;
  end: number;
  /** The sentence, trimmed, including its `?`. */
  text: string;
  kind: AgentQuestionKind;
}

/**
 * Openers that make a sentence a yes/no question. "Want me to…?" and
 * "Shall we…?" are the agent-typical ones; the auxiliaries cover the rest.
 */
const YES_NO_OPENERS = new Set([
  'am',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'is',
  'may',
  'might',
  'must',
  'shall',
  'should',
  'want',
  'was',
  'were',
  'will',
  'would',
  "isn't",
  "aren't",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "wouldn't",
  "shouldn't",
  "can't",
  "couldn't",
]);

/** Lead-ins stripped before reading the opener: "So, should I…?" */
const LEAD_IN_RE =
  /^(?:(?:so|ok(?:ay)?|also|now|then|and|but|alright|great|next|finally|lastly|quick question)\b[,:\s]*)+/i;

/**
 * Sentence boundaries: terminal punctuation FOLLOWED BY whitespace or the end,
 * or a line break. The lookahead is what keeps `check.js?` and `v1.2` whole.
 */
const BOUNDARY_RE = /[.!?]+(?=\s|$)|\n+/g;

/** "…, or should I …?" — a choice between options is not a yes/no. */
const CHOICE_RE = /,?\s+or\s+(?!not\b)\S/i;

/** The kind of a wh-question, from its opening words. */
function whKind(sentence: string): AgentQuestionKind | null {
  const s = sentence.toLowerCase();
  if (/^(?:when|what time|what day|what date|by when|until when|how soon)\b/.test(s)) {
    return /^(?:what day|what date)\b/.test(s) ? 'date' : 'datetime';
  }
  if (/^how (?:many|much)\b/.test(s)) return 'number';
  if (/^(?:what|which)(?:'s| is| should be)? (?:your |the )?e-?mail\b/.test(s)) return 'email';
  if (/^(?:what|which|who|whom|whose|where|why|how)\b/.test(s)) return 'text';
  return null;
}

/**
 * The kind of answer a single question sentence wants, or `null` when it is
 * not a direct question.
 */
export function classifyQuestion(sentence: string): AgentQuestionKind | null {
  const trimmed = sentence.trim();
  if (!trimmed.endsWith('?')) return null;
  const body = trimmed.replace(LEAD_IN_RE, '').trim();
  const opener = body.split(/[\s,]+/)[0]?.toLowerCase() ?? '';
  if (YES_NO_OPENERS.has(opener)) {
    // "Should I use A or B?" asks for a choice, which Yes/No cannot answer.
    return CHOICE_RE.test(body) ? 'text' : 'yes-no';
  }
  return whKind(body);
}

/** `text` cut into sentences, each with its offset. Punctuation stays attached. */
export function splitSentences(text: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let last = 0;
  const push = (from: number, to: number): void => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const sentence = raw.trim();
    if (sentence) out.push({ start: from + lead, text: sentence });
  };
  for (const match of text.matchAll(BOUNDARY_RE)) {
    const index = match.index ?? 0;
    const isBreak = match[0].startsWith('\n');
    push(last, isBreak ? index : index + match[0].length);
    last = index + match[0].length;
  }
  push(last, text.length);
  return out;
}

/** Every direct question in `text`, in order. */
export function findAgentQuestions(text: string): AgentQuestion[] {
  const out: AgentQuestion[] = [];
  for (const { start, text: sentence } of splitSentences(text)) {
    if (sentence.length < 4) continue;
    const kind = classifyQuestion(sentence);
    if (!kind) continue;
    out.push({ start, end: start + sentence.length, text: sentence, kind });
  }
  return out;
}
