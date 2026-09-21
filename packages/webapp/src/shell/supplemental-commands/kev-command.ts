/**
 * `kev` — typed decisions from a Kev model in the browser.
 *
 * The cone keeps the plan. This command scores yes/no, choice, and rating
 * questions against a piece of text (a ticket, `computer text`, a snapshot)
 * and prints probabilities. Weights download on the first `ask`.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import { fail, ok, readArgText, readPipedOrFlag } from './decision/io.js';
import {
  formatAnswers,
  parseQuestionPositionals,
  parseQuestionsJson,
  parseStateText,
} from './decision/kev-questions.js';
import type { KevModelName, KevRuntime } from './decision/runtime.js';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

const log = createLogger('kev');

const VALUE_FLAGS = ['--state', '--questions', '--model', '--from'];

export function kevHelpText(): string {
  return `kev — typed decisions from a local Kev model

Usage:
  kev ask [name:type:instruction ...] [options]

  ask                  Score questions against a piece of text
                       name:noul:Is this about billing?
                       name:choice:What tone?::calm|frustrated|angry
                       name:score:How urgent?::can wait|this week|today
                       --state file|-     text to judge (default: stdin when piped)
                       --questions file   System One questions JSON, instead of positionals
                       --model 0.8b|4b|9b default 0.8b (4b is 4.7 GB, 9b is 8.8 GB)
                       --from url|path    weight directory (default: Hugging Face)
                       --date-facts       append day counts between absolute dates
                       --json             print the System One response

The first ask downloads the weights and needs onnxruntime-web
(\`ipk add onnxruntime-web\`, the same package say and hear use).
Nothing in the answer is free text: each question picks one of the options you gave it.
`;
}

interface AskFlags {
  state: string | null;
  questionsFile: string | null;
  model: KevModelName;
  from: string | null;
  dateFacts: boolean;
  json: boolean;
  positionals: string[];
}

function applyAskValue(parsed: AskFlags, flag: string, value: string): void {
  if (flag === '--state') parsed.state = value;
  else if (flag === '--questions') parsed.questionsFile = value;
  else if (flag === '--from') parsed.from = value;
  else if (value === '0.8b' || value === '4b' || value === '9b') parsed.model = value;
  else throw new Error('--model must be 0.8b, 4b, or 9b');
}

function parseAsk(args: readonly string[]): AskFlags {
  const parsed: AskFlags = {
    state: null,
    questionsFile: null,
    model: '0.8b',
    from: null,
    dateFacts: false,
    json: false,
    positionals: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--date-facts') parsed.dateFacts = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--') {
      parsed.positionals.push(...args.slice(i + 1));
      break;
    } else if (VALUE_FLAGS.includes(arg)) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      applyAskValue(parsed, arg, value);
    } else if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
    else parsed.positionals.push(arg);
  }
  return parsed;
}

async function runAsk(args: readonly string[], ctx: CommandContext, runtime: KevRuntime) {
  const flags = parseAsk(args);
  const questions = flags.questionsFile
    ? parseQuestionsJson(await readArgText(ctx, flags.questionsFile))
    : parseQuestionPositionals(flags.positionals);
  if (flags.questionsFile && flags.positionals.length > 0) {
    throw new Error('pass questions as --questions or as positionals, not both');
  }
  if (Object.keys(questions).length === 0) {
    throw new Error('give at least one question (see kev ask --help)');
  }
  const stateText = await readPipedOrFlag(ctx, flags.state);
  if (stateText === null || stateText.trim() === '') {
    throw new Error('give the text to judge with --state, or pipe it');
  }
  const from =
    flags.from && !/^https?:\/\//i.test(flags.from)
      ? ctx.fs.resolvePath(ctx.cwd, flags.from)
      : flags.from;
  const response = await runtime.ask({
    state: parseStateText(stateText),
    questions,
    model: flags.model,
    from,
    dateFacts: flags.dateFacts,
  });
  if (flags.json) return ok(`${JSON.stringify(response, null, 2)}\n`);
  return ok(formatAnswers(response.answers));
}

export interface KevCommandOptions {
  /** Test double. Production loads @ai-ecoverse/kev.js on the first ask. */
  runtime?: KevRuntime;
}

async function resolveRuntime(options: KevCommandOptions): Promise<KevRuntime> {
  if (options.runtime) return options.runtime;
  const { createDefaultKevRuntime } = await import('./decision/runtime.js');
  return createDefaultKevRuntime();
}

export function createKevCommand(options: KevCommandOptions = {}): Command {
  return defineCommand('kev', async (args, ctx) => {
    if (isHelpRequest(args, { valueFlags: VALUE_FLAGS })) {
      const sub = args[0];
      const help = kevHelpText();
      const stdout =
        sub && sub !== '--help' && sub !== '-h' ? subcommandHelpText('kev', sub, help) : help;
      return { stdout, stderr: '', exitCode: 0 };
    }
    const sub = args[0] ?? '';
    try {
      switch (sub) {
        case 'ask':
          return await runAsk(args.slice(1), ctx, await resolveRuntime(options));
        default:
          return fail('kev', sub ? `unknown subcommand ${sub}` : 'give a subcommand (kev ask)');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('ask failed', { message });
      return fail('kev', message);
    }
  });
}
