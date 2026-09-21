/**
 * `cua-s1` — form-filling decisions from Cua's cua-s1-forms model.
 *
 * `elements` reads a playwright snapshot and emits the Edit / CheckBox /
 * Button list the model was trained on. `plan` scores that list against a
 * document's `Label: value` lines. `commands` prints the `playwright-cli`
 * lines for the ordered actions. The command never fills the page itself.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import { fail, ok, readArgText, readPipedOrFlag } from './decision/io.js';
import { formatPlan, parsePrintedPlan, planToPlaywrightLines } from './decision/plan-commands.js';
import type { CuaRuntime } from './decision/runtime.js';
import { elementsFromSnapshot, type FormElement } from './decision/snapshot-elements.js';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

const log = createLogger('cua-s1');

const VALUE_FLAGS = [
  '--snapshot',
  '--elements',
  '--document',
  '--title',
  '--min-confidence',
  '--from',
  '--plan',
  '--tab',
];

export function cuaS1HelpText(): string {
  return `cua-s1 — form decisions from the cua-s1-forms model

Usage:
  cua-s1 elements --snapshot file
  cua-s1 plan [--snapshot file | --elements file] [--document file]
  cua-s1 commands --plan file --tab <id>

  elements              Map a playwright-cli snapshot to Edit / CheckBox / Button JSON
                        --snapshot file|-
  plan                  Score the form. Prints the plan; does not touch the page
                        --snapshot file|-     snapshot text (title + fields)
                        --elements file|-     JSON from \`cua-s1 elements\` instead
                        --document file|-     Label: value lines (default: stdin when piped)
                        --title text          overrides the snapshot's Page Title
                        --min-confidence 0.5  drop weaker decisions (default 0.5)
                        --allow-submit        keep one Submit click (off unless you pass this)
                        --from url|path       weight directory (default: Hugging Face, 3.3 MB)
                        --json                print the plan as JSON for \`commands\`
  commands              Print playwright-cli lines for the plan's actions
                        --plan file|-
                        --tab <targetId>

Run \`playwright-cli snapshot\` first. Selects and radios are left out.
A hidden tab throttles the model, so plan from the visible leader.
The first plan needs onnxruntime-web (\`ipk add onnxruntime-web\`).
`;
}

function take(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

async function runElements(args: readonly string[], ctx: CommandContext) {
  let snapshot: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--snapshot') {
      snapshot = await readArgText(ctx, take(args, ++i, arg));
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
    throw new Error(`unexpected argument ${arg}`);
  }
  if (snapshot === null) throw new Error('--snapshot is required');
  const form = elementsFromSnapshot(snapshot);
  return ok(`${JSON.stringify(form, null, 2)}\n`);
}

const PLAN_VALUE_FLAGS = [
  '--snapshot',
  '--elements',
  '--document',
  '--title',
  '--min-confidence',
  '--from',
];

interface PlanFlags {
  snapshot: string | null;
  elementsFile: string | null;
  documentFlag: string | null;
  title: string;
  minConfidence: number;
  allowSubmit: boolean;
  from: string | null;
  asJson: boolean;
}

function confidenceOf(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('--min-confidence must be between 0 and 1');
  }
  return parsed;
}

async function applyPlanValue(
  flags: PlanFlags,
  ctx: CommandContext,
  arg: string,
  value: string
): Promise<void> {
  if (arg === '--snapshot') flags.snapshot = await readArgText(ctx, value);
  else if (arg === '--elements') flags.elementsFile = value;
  else if (arg === '--document') flags.documentFlag = value;
  else if (arg === '--title') flags.title = value;
  else if (arg === '--from') flags.from = value;
  else flags.minConfidence = confidenceOf(value);
}

async function readPlanFlags(args: readonly string[], ctx: CommandContext): Promise<PlanFlags> {
  const flags: PlanFlags = {
    snapshot: null,
    elementsFile: null,
    documentFlag: null,
    title: '',
    minConfidence: 0.5,
    allowSubmit: false,
    from: null,
    asJson: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-submit') flags.allowSubmit = true;
    else if (arg === '--json') flags.asJson = true;
    else if (!PLAN_VALUE_FLAGS.includes(arg)) {
      throw new Error(arg.startsWith('-') ? `unknown flag ${arg}` : `unexpected argument ${arg}`);
    } else await applyPlanValue(flags, ctx, arg, take(args, ++i, arg));
  }
  return flags;
}

async function loadPlanElements(
  ctx: CommandContext,
  flags: PlanFlags
): Promise<{ title: string; elements: FormElement[] }> {
  if (flags.snapshot !== null && flags.elementsFile !== null) {
    throw new Error('pass --snapshot or --elements, not both');
  }
  if (flags.snapshot !== null) {
    const form = elementsFromSnapshot(flags.snapshot);
    return { title: flags.title || form.title, elements: form.elements };
  }
  if (flags.elementsFile === null) throw new Error('pass --snapshot or --elements');
  const parsed = JSON.parse(await readArgText(ctx, flags.elementsFile)) as {
    title?: string;
    elements?: FormElement[];
  };
  return { title: flags.title || parsed.title || '', elements: parsed.elements ?? [] };
}

async function runPlan(args: readonly string[], ctx: CommandContext, runtime: CuaRuntime) {
  const flags = await readPlanFlags(args, ctx);
  const loaded = await loadPlanElements(ctx, flags);
  if (loaded.elements.length === 0) {
    throw new Error('the snapshot has no text fields, checkboxes, or buttons');
  }
  const document = await readPipedOrFlag(ctx, flags.documentFlag);
  if (document === null) throw new Error('give the document with --document, or pipe it');
  const weightFrom =
    flags.from && !/^https?:\/\//i.test(flags.from)
      ? ctx.fs.resolvePath(ctx.cwd, flags.from)
      : flags.from;
  const plan = await runtime.plan({
    title: loaded.title,
    elements: loaded.elements,
    document,
    minConfidence: flags.minConfidence,
    allowSubmit: flags.allowSubmit,
    from: weightFrom,
  });
  return ok(flags.asJson ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan));
}

async function runCommands(args: readonly string[], ctx: CommandContext) {
  let planFlag: string | null = null;
  let tab = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--plan') {
      planFlag = take(args, ++i, arg);
      continue;
    }
    if (arg === '--tab') {
      tab = take(args, ++i, arg);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
    throw new Error(`unexpected argument ${arg}`);
  }
  if (!tab) throw new Error('--tab is required');
  const planText = await readPipedOrFlag(ctx, planFlag);
  if (planText === null) throw new Error('give the plan with --plan, or pipe it');
  const lines = planToPlaywrightLines(parsePrintedPlan(planText), tab);
  return ok(lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

export interface CuaS1CommandOptions {
  /** Test double. Production loads @ai-ecoverse/cua-s1.js on the first plan. */
  runtime?: CuaRuntime;
}

async function resolveRuntime(options: CuaS1CommandOptions): Promise<CuaRuntime> {
  if (options.runtime) return options.runtime;
  const { createDefaultCuaRuntime } = await import('./decision/runtime.js');
  return createDefaultCuaRuntime();
}

export function createCuaS1Command(options: CuaS1CommandOptions = {}): Command {
  return defineCommand('cua-s1', async (args, ctx) => {
    if (isHelpRequest(args, { valueFlags: VALUE_FLAGS })) {
      const sub = args[0];
      const help = cuaS1HelpText();
      const stdout =
        sub && sub !== '--help' && sub !== '-h' ? subcommandHelpText('cua-s1', sub, help) : help;
      return { stdout, stderr: '', exitCode: 0 };
    }
    const sub = args[0] ?? '';
    try {
      switch (sub) {
        case 'elements':
          return await runElements(args.slice(1), ctx);
        case 'plan':
          return await runPlan(args.slice(1), ctx, await resolveRuntime(options));
        case 'commands':
          return await runCommands(args.slice(1), ctx);
        default:
          return fail(
            'cua-s1',
            sub ? `unknown subcommand ${sub}` : 'give a subcommand (cua-s1 plan)'
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('failed', { message });
      return fail('cua-s1', message);
    }
  });
}
