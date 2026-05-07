/**
 * CLI entry: `tsx src/index.ts` (wired through npm scripts).
 *
 * Probes the SwiftLM endpoint, runs the requested scenarios in order
 * through pi-agent-core's `runAgentLoop`, prints per-scenario lines
 * plus a summary, and exits with conventional codes:
 *   0   every selected scenario passed (or XFAIL'd as expected)
 *   1   one or more scenarios failed unexpectedly
 *   2   endpoint unreachable / model not loaded
 *   64  usage error
 */

import { parseArgs } from 'node:util';

import { runScenario } from './runner.js';
import { SCENARIOS, scenarioByName, type Scenario } from './scenarios.js';
import { Sandbox } from './sandbox.js';
import { pickTools } from './tools.js';
import { buildSyntheticPadding } from './padding.js';
import {
  buildSwiftLMModel,
  ensureProviders,
  probeAndPickModel,
  SWIFTLM_DEFAULT_BASE_URL,
} from './swiftlm-model.js';

type Marker = 'PASS' | 'FAIL' | 'XFAIL' | 'XPASS';

interface CliArgs {
  endpoint: string;
  model: string | null;
  scenario: string | null;
  list: boolean;
  verbose: boolean;
  padTo: number;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string', default: SWIFTLM_DEFAULT_BASE_URL },
      model: { type: 'string' },
      scenario: { type: 'string' },
      list: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      'pad-to': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      `Usage: npm run eval -w @slicc/local-models-eval -- [options]\n\n` +
        `Options:\n` +
        `  --endpoint <url>      SwiftLM base URL (default: ${SWIFTLM_DEFAULT_BASE_URL})\n` +
        `  --model <id>          Model id; auto-detected from /v1/models when omitted\n` +
        `  --scenario <name>     Run a single scenario (default: run all)\n` +
        `  --list                List available scenarios and exit\n` +
        `  --verbose, -v         Print per-round transcripts even on PASS\n` +
        `  --pad-to <tokens>     Prepend synthetic SLICC-shaped context (skill\n` +
        `                        blocks, memory entries, instructions) to each\n` +
        `                        scenario's system prompt up to ~N tokens. Default 0.\n` +
        `                        Try 8000, 16000, 25000 to compare against the\n` +
        `                        ~33K production context size.\n`
    );
    process.exit(0);
  }
  const padTo = Number.parseInt(values['pad-to']!, 10);
  if (!Number.isFinite(padTo) || padTo < 0) {
    process.stderr.write(`--pad-to must be a non-negative integer; got ${values['pad-to']}\n`);
    process.exit(64);
  }
  return {
    endpoint: values.endpoint!,
    model: values.model ?? null,
    scenario: values.scenario ?? null,
    list: !!values.list,
    verbose: !!values.verbose,
    padTo,
  };
}

function pickMarker(expectedPass: boolean, ok: boolean): Marker {
  if (ok && expectedPass) return 'PASS';
  if (ok && !expectedPass) return 'XPASS';
  if (!ok && !expectedPass) return 'XFAIL';
  return 'FAIL';
}

function previewArgs(args: unknown): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? json.slice(0, 120) + '…' : json;
}

function printRoundLogs(result: Awaited<ReturnType<typeof runScenario>>): void {
  for (const round of result.rounds) {
    process.stdout.write(`  R${round.index}\n`);
    for (const tc of round.toolCalls) {
      process.stdout.write(`     → ${tc.name}(${previewArgs(tc.arguments)})\n`);
    }
    for (const result of round.toolResults) {
      const oneLine = result.replace(/\n/g, ' ⏎ ');
      const clipped = oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
      process.stdout.write(`     ← ${clipped}\n`);
    }
    if (round.isFinal && round.text) {
      const clipped = round.text.length > 240 ? round.text.slice(0, 240) + '…' : round.text;
      process.stdout.write(`     final: ${clipped}\n`);
    }
  }
}

async function runOne(
  scenario: Scenario,
  modelId: string,
  endpoint: string,
  verbose: boolean,
  paddingText: string
): Promise<Marker> {
  const sandbox = scenario.needsSandbox ? Sandbox.create(scenario.name) : null;
  try {
    if (sandbox && scenario.setup) scenario.setup(sandbox);
    const tools = pickTools(scenario.toolNames, sandbox);
    const model = buildSwiftLMModel({ modelId, baseUrl: endpoint });
    // Padding goes BEFORE the scenario's system prompt so the
    // scenario-specific instructions are the freshest thing in the
    // model's attention before the user message — same ordering
    // SLICC's `buildSystemPrompt` uses (project context first, task
    // instructions last).
    const systemPrompt = paddingText
      ? `${paddingText}\n\n---\n\n${scenario.system}`
      : scenario.system;
    const result = await runScenario({
      model,
      systemPrompt,
      userPrompt: scenario.user,
      tools,
      maxRounds: scenario.maxRounds,
    });
    const verdict = scenario.verify(result);
    const marker = pickMarker(scenario.expectedPass, verdict.ok);
    const seconds = (result.totalElapsedMs / 1_000).toFixed(2);
    process.stdout.write(
      `[${marker.padEnd(5)}] ${scenario.name.padEnd(20)} ` +
        `${result.rounds.length} rounds  ${seconds}s  — ${verdict.reason}\n`
    );
    // Print transcripts when something is genuinely off (FAIL / XPASS),
    // or when the user asked for verbose.
    if (verbose || marker === 'FAIL' || marker === 'XPASS') {
      printRoundLogs(result);
    }
    return marker;
  } finally {
    sandbox?.dispose();
  }
}

async function main(): Promise<number> {
  const args = parseCli();

  if (args.list) {
    process.stdout.write(`${SCENARIOS.length} scenario(s):\n`);
    for (const s of SCENARIOS) {
      const tag = s.expectedPass ? '' : ' [xfail]';
      process.stdout.write(`  ${s.name.padEnd(20)} — ${s.description}${tag}\n`);
    }
    return 0;
  }

  let selected: Scenario[];
  if (args.scenario) {
    const found = scenarioByName(args.scenario);
    if (!found) {
      const names = SCENARIOS.map((s) => s.name).join(', ');
      process.stderr.write(
        `unknown scenario ${JSON.stringify(args.scenario)}; choose from: ${names}\n`
      );
      return 64;
    }
    selected = [found];
  } else {
    selected = [...SCENARIOS];
  }

  const probe = await probeAndPickModel(args.endpoint);
  if (!probe.ok) {
    process.stderr.write(`endpoint check failed: ${probe.reason}\n`);
    return 2;
  }
  const modelId = args.model ?? probe.modelId;

  ensureProviders();

  // Build the synthetic padding once and reuse for every scenario, so
  // the same blob (and same prompt-cache identity) is sent across runs
  // — that way variance between scenarios is attributable to the
  // scenario, not to a freshly generated padding chunk.
  const padding = buildSyntheticPadding(args.padTo);

  process.stdout.write(`endpoint: ${args.endpoint}\n`);
  process.stdout.write(`model:    ${modelId}\n`);
  process.stdout.write(`running:  ${selected.length} scenario(s)\n`);
  if (args.padTo > 0) {
    process.stdout.write(
      `padding:  target ~${args.padTo} tok, actual ~${padding.approxTokens} tok ` +
        `(${padding.chars} chars; ${padding.filesIncluded.length} vfs-root files`
    );
    if (padding.filesSkipped.length > 0) {
      process.stdout.write(`, ${padding.filesSkipped.length} skipped over budget`);
    }
    process.stdout.write(`)\n`);
  }
  process.stdout.write(`\n`);

  const counts: Record<Marker, string[]> = { PASS: [], FAIL: [], XFAIL: [], XPASS: [] };
  for (const scenario of selected) {
    const marker = await runOne(scenario, modelId, args.endpoint, args.verbose, padding.text);
    counts[marker].push(scenario.name);
  }

  process.stdout.write(`\n`);
  const summary = (['PASS', 'FAIL', 'XFAIL', 'XPASS'] as const)
    .filter((m) => counts[m].length > 0)
    .map((m) => `${m}=${counts[m].length}`)
    .join('  ');
  process.stdout.write(`summary: ${summary}\n`);

  if (counts.FAIL.length > 0) {
    process.stdout.write(`failed: ${counts.FAIL.join(', ')}\n`);
    return 1;
  }
  if (counts.XPASS.length > 0) {
    process.stdout.write(
      `unexpected pass: ${counts.XPASS.join(', ')} — ` +
        `consider flipping expectedPass=true in scenarios.ts\n`
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  }
);
