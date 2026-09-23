export type AgentQuestionKind = 'yes-no' | 'text' | 'number' | 'datetime' | 'date' | 'email';

export interface AgentQuestion {
  start: number;
  end: number;

  text: string;
  kind: AgentQuestionKind;
}

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

const LEAD_IN_RE =
  /^(?:(?:so|ok(?:ay)?|also|now|then|and|but|alright|great|next|finally|lastly|quick question)\b[,:\s]*)+/i;

const BOUNDARY_RE = /[.!?]+(?=\s|$)|\n+/g;

const CHOICE_RE = /,?\s+or\s+(?!not\b)\S/i;

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

export function classifyQuestion(sentence: string): AgentQuestionKind | null {
  const trimmed = sentence.trim();
  if (!trimmed.endsWith('?')) return null;
  const body = trimmed.replace(LEAD_IN_RE, '').trim();
  const opener = body.split(/[\s,]+/)[0]?.toLowerCase() ?? '';
  if (YES_NO_OPENERS.has(opener)) {
    return CHOICE_RE.test(body) ? 'text' : 'yes-no';
  }
  return whKind(body);
}

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
