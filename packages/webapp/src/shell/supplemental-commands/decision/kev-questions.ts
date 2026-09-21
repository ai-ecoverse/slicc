/**
 * Question shorthand and answer formatting for `kev ask`.
 *
 * The JSON file is the full System One question map. A positional uses
 * `name:noul:instruction` or `name:choice|score:instruction::a|b|c`.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, JsonValue>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type KevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  confidence: number;
}

export type KevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

const NAME_RE = /^[A-Za-z_][\w-]*$/;

function parseCriteria(
  kind: 'choice' | 'score',
  raw: string
): ChoiceQuestion['criteria'] | string[] {
  const parts = raw
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) {
    throw new Error(`${kind} needs at least two options after ::, separated by |`);
  }
  if (kind === 'score') return parts;
  const criteria: Record<string, JsonValue> = {};
  for (const part of parts) criteria[part] = null;
  return criteria;
}

/** Parse one positional `name:type:instruction[::options]`. */
export function parseQuestionShorthand(token: string): [string, KevQuestion] {
  const first = token.indexOf(':');
  const second = first === -1 ? -1 : token.indexOf(':', first + 1);
  if (first <= 0 || second === -1) {
    throw new Error(
      `bad question ${JSON.stringify(token)} (want name:noul:instruction or name:choice:instruction::a|b)`
    );
  }
  const name = token.slice(0, first);
  const kind = token.slice(first + 1, second);
  const rest = token.slice(second + 1);
  if (!NAME_RE.test(name)) throw new Error(`bad question name ${JSON.stringify(name)}`);
  if (kind !== 'noul' && kind !== 'choice' && kind !== 'score') {
    throw new Error(`unknown question type ${JSON.stringify(kind)} (noul, choice, score)`);
  }
  if (kind === 'noul') {
    if (!rest.trim()) throw new Error(`noul question ${name} needs an instruction`);
    return [name, { type: 'noul', instructions: rest }];
  }
  const splitAt = rest.indexOf('::');
  if (splitAt === -1) {
    throw new Error(`${kind} question ${name} needs instruction::opt1|opt2`);
  }
  const instructions = rest.slice(0, splitAt);
  if (!instructions.trim()) throw new Error(`${kind} question ${name} needs an instruction`);
  const criteria = parseCriteria(kind, rest.slice(splitAt + 2));
  if (kind === 'choice') {
    return [
      name,
      { type: 'choice', instructions, criteria: criteria as ChoiceQuestion['criteria'] },
    ];
  }
  return [name, { type: 'score', instructions, criteria: criteria as string[] }];
}

export function parseQuestionPositionals(tokens: readonly string[]): Record<string, KevQuestion> {
  const questions: Record<string, KevQuestion> = {};
  for (const token of tokens) {
    const [name, question] = parseQuestionShorthand(token);
    if (questions[name]) throw new Error(`duplicate question ${name}`);
    questions[name] = question;
  }
  return questions;
}

interface QuestionJson {
  type?: string;
  instructions?: string;
  criteria?: JsonValue;
}

function instructionsOf(name: string, record: QuestionJson): string {
  if (typeof record.instructions !== 'string' || !record.instructions.trim()) {
    throw new Error(`question ${name} needs a string instructions field`);
  }
  return record.instructions;
}

function questionFromJson(name: string, value: unknown): KevQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`question ${name} must be an object`);
  }
  const record = value as QuestionJson;
  const instructions = instructionsOf(name, record);
  if (record.type === 'noul') return { type: 'noul', instructions };
  if (record.type === 'choice') {
    const criteria = record.criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new Error(`choice question ${name} needs a criteria object`);
    }
    return { type: 'choice', instructions, criteria };
  }
  if (record.type === 'score') {
    if (
      !Array.isArray(record.criteria) ||
      record.criteria.some((item) => typeof item !== 'string')
    ) {
      throw new Error(`score question ${name} needs a criteria array of strings`);
    }
    return { type: 'score', instructions, criteria: record.criteria as string[] };
  }
  throw new Error(`question ${name} has unknown type ${JSON.stringify(record.type)}`);
}

/** Accept a System One `questions` object. Throws on a shape the shorthand would also reject. */
export function parseQuestionsJson(text: string): Record<string, KevQuestion> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`questions are not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('questions JSON must be an object of name → question');
  }
  const questions: Record<string, KevQuestion> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!NAME_RE.test(name)) throw new Error(`bad question name ${JSON.stringify(name)}`);
    questions[name] = questionFromJson(name, value);
  }
  if (Object.keys(questions).length === 0) throw new Error('questions JSON is empty');
  return questions;
}

/** Keep objects and arrays as structured state so field names survive. Other text stays a string. */
export function parseStateText(text: string): JsonValue {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as JsonValue;
    } catch {
      // A document that merely starts with a brace is still prose.
    }
  }
  return text.replace(/\s+$/, '');
}

function formatProbability(value: number): string {
  return value.toFixed(2);
}

export function formatAnswers(answers: Record<string, KevAnswer>): string {
  const lines: string[] = [];
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === 'noul') {
      const yes = answer.noul >= 0.5;
      lines.push(`${name}\t${yes ? 'yes' : 'no'}\t${formatProbability(answer.noul)}`);
      continue;
    }
    if (answer.type === 'choice') {
      lines.push(`${name}\t${answer.choice}\t${formatProbability(answer.confidence)}`);
      continue;
    }
    const level = answer.legend[String(answer.score)] ?? String(answer.score);
    lines.push(`${name}\t${level}\t${formatProbability(answer.confidence)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
