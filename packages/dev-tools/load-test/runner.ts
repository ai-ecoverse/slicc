#!/usr/bin/env tsx
/**
 * Load Test Runner — spawns N parallel SLICC instances and runs scenarios.
 *
 * Usage:
 *   npx tsx packages/dev-tools/load-test/runner.ts --instances 3 --prompt "Create hello.txt"
 *   npx tsx packages/dev-tools/load-test/runner.ts -n 5 --prompts-file scenarios.jsonl
 */

import { readFileSync, mkdirSync, writeFileSync, unlinkSync, statSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { InstanceController } from './instance-controller.js';
import type { LoadTestConfig, LoadTestReport, Scenario, InstanceResult } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function requireInt(value: string, flag: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.error(`Error: ${flag} requires a positive integer, got: ${value}`);
    process.exit(1);
  }
  return n;
}

function parseArgs(argv: string[]): LoadTestConfig {
  const config: LoadTestConfig = {
    instances: 2,
    basePort: 7100,
    timeoutSeconds: 1800,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    if ((arg === '--instances' || arg === '-n') && next) {
      config.instances = requireInt(next, arg);
      i++;
    } else if (arg === '--prompt' && next) {
      config.prompt = next;
      i++;
    } else if (arg === '--prompts-file' && next) {
      config.promptsFile = next;
      i++;
    } else if (arg === '--scenario' && next) {
      // Shorthand for built-in scenarios in the scenarios/ directory
      config.promptsFile = resolve(__dirname, 'scenarios', `${next}.jsonl`);
      i++;
    } else if (arg === '--base-port' && next) {
      config.basePort = requireInt(next, arg);
      i++;
    } else if (arg === '--timeout' && next) {
      config.timeoutSeconds = requireInt(next, arg);
      i++;
    } else if (arg === '--env-file' && next) {
      config.envFile = next;
      i++;
    } else if (arg === '--adobe-token' && next) {
      config.adobeToken = next;
      i++;
    } else if (arg === '--adobe-token-file' && next) {
      config.adobeToken = readFileSync(resolve(next), 'utf-8').trim();
      i++;
    } else if (arg === '--model' && next) {
      config.modelId = next;
      i++;
    } else if (arg === '--bedrock' && next) {
      // Shorthand: --bedrock <env-file> loads all three Bedrock vars
      const envContent = readFileSync(resolve(next), 'utf-8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^(\w+)=(.+)$/);
        if (!match) continue;
        const [, key, val] = match;
        if (key === 'BEDROCK_API_KEY') config.bedrockApiKey = val;
        if (key === 'BEDROCK_BASE_URL') config.bedrockBaseUrl = val;
        if (key === 'BEDROCK_MODEL') config.bedrockModelId = val;
      }
      i++;
    } else if (arg === '--extension' && next) {
      config.extensionPath = next;
      i++;
    } else if (arg === '--extension-url' && next) {
      config.extensionUrl = next;
      i++;
    } else if (arg === '--no-wait') {
      config.noWait = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  // Load credentials from .env in repo root (single source of truth).
  // CLI flags override .env values. Adobe takes priority over Bedrock.
  if (!config.adobeToken && !config.bedrockApiKey) {
    try {
      const envContent = readFileSync(resolve(REPO_ROOT, '.env'), 'utf-8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^(\w+)=(.+)$/);
        if (!match) continue;
        const [, key, val] = match;
        if (key === 'ADOBE_TOKEN') config.adobeToken = val;
        if (key === 'BEDROCK_API_KEY') config.bedrockApiKey = val;
        if (key === 'BEDROCK_BASE_URL') config.bedrockBaseUrl = val;
        if (key === 'BEDROCK_MODEL') config.bedrockModelId = val;
      }
    } catch {
      // No .env file — continue
    }
  }

  // Adobe takes priority over Bedrock when both are in .env
  if (config.adobeToken && config.bedrockApiKey) {
    config.bedrockApiKey = undefined;
    config.bedrockBaseUrl = undefined;
    config.bedrockModelId = undefined;
  }

  if (!config.prompt && !config.promptsFile) {
    console.error('Error: --prompt or --prompts-file is required.\n');
    printUsage();
    process.exit(1);
  }

  return config;
}

function printUsage(): void {
  console.log(`
SLICC Load Test Runner

Usage:
  npx tsx packages/dev-tools/load-test/runner.ts [options]

Options:
  --instances, -n <count>   Number of parallel instances (default: 2)
  --prompt <text>           Single prompt for all instances
  --prompts-file <path>     JSONL file with per-instance scenarios
  --scenario <name>         Built-in scenario name (e.g., migration, basic)
  --base-port <port>        Starting port (default: 5800)
  --timeout <seconds>       Per-instance timeout (default: 1800 / 30min)
  --env-file <path>         Path to .env file with API keys
  --adobe-token <token>     Adobe IMS access token (injected into each instance)
  --adobe-token-file <path> Read Adobe token from a file (avoids CLI exposure)
  --model <id>              Model ID to select (default: claude-sonnet-4-6)

Environment:
  LOAD_TEST_VERBOSE=1       Show all stdout/stderr from each instance
`);
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

function loadScenarios(config: LoadTestConfig): Scenario[] {
  if (config.promptsFile) {
    const content = readFileSync(resolve(config.promptsFile), 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Scenario);
  }
  return [{ prompt: config.prompt! }];
}

/** Round-robin assignment when fewer scenarios than instances. */
function assignScenarios(scenarios: Scenario[], count: number): Scenario[] {
  return Array.from({ length: count }, (_, i) => scenarios[i % scenarios.length]!);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function computeReport(
  config: LoadTestConfig,
  results: InstanceResult[],
  startedAt: Date
): LoadTestReport {
  const durations = results
    .filter((r) => r.durationMs != null)
    .map((r) => r.durationMs!)
    .sort((a, b) => a - b);

  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)]! : 0;
  // For small N (< 20), p95 converges toward the max — expected behavior
  const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)]! : 0;

  return {
    config,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    instances: results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.result === 'pass').length,
      failed: results.filter((r) => r.result === 'fail').length,
      timedOut: results.filter((r) => r.result === 'timeout').length,
      errored: results.filter((r) => r.result === 'error').length,
      avgDurationMs: Math.round(avg),
      p50DurationMs: Math.round(p50),
      p95DurationMs: Math.round(p95),
    },
  };
}

function printReport(report: LoadTestReport): void {
  console.log('\n' + '='.repeat(70));
  console.log('SLICC LOAD TEST RESULTS');
  console.log('='.repeat(70));

  for (const inst of report.instances) {
    const dur = inst.durationMs != null ? `${(inst.durationMs / 1000).toFixed(1)}s` : 'N/A';
    const status = inst.result.toUpperCase().padEnd(7);
    const err = inst.error ? ` — ${inst.error.slice(0, 60)}` : '';
    console.log(`  Instance ${inst.index + 1} (port ${inst.port}): ${status} ${dur}${err}`);
  }

  console.log('\n' + '-'.repeat(70));
  const s = report.summary;
  console.log(
    `  Summary: ${s.passed}/${s.total} passed` +
      (s.failed ? `, ${s.failed} failed` : '') +
      (s.timedOut ? `, ${s.timedOut} timed out` : '') +
      (s.errored ? `, ${s.errored} errored` : '')
  );

  if (s.passed > 0) {
    console.log(
      `  Timing:  avg ${(s.avgDurationMs / 1000).toFixed(1)}s` +
        `, p50 ${(s.p50DurationMs / 1000).toFixed(1)}s` +
        `, p95 ${(s.p95DurationMs / 1000).toFixed(1)}s`
    );
  }

  console.log('='.repeat(70) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Kill leftover Chrome/server processes and clean all profile dirs. */
function cleanSlate(): void {
  // Kill leftover SLICC servers and Chrome CDP instances
  try {
    execSync('pkill -f "remote-debugging" 2>/dev/null', { stdio: 'ignore' });
  } catch {
    /* none */
  }
  try {
    execSync('pkill -f "dist/node-server/index.js" 2>/dev/null', { stdio: 'ignore' });
  } catch {
    /* none */
  }

  // Remove all Chrome profile dirs
  const tmp = tmpdir();
  try {
    for (const entry of readdirSync(tmp)) {
      if (entry.startsWith('browser-coding-agent-chrome')) {
        execSync(`rm -rf ${JSON.stringify(resolve(tmp, entry))}`, { stdio: 'ignore' });
      }
    }
  } catch {
    /* tmpdir read failure — unlikely */
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const scenarios = loadScenarios(config);
  const assigned = assignScenarios(scenarios, config.instances);
  const startedAt = new Date();

  console.log(`\nSLICC Load Test — ${config.instances} instances, base port ${config.basePort}`);
  console.log('Cleaning previous state...');
  cleanSlate();
  console.log(`Timeout: ${config.timeoutSeconds}s per instance`);
  if (config.extensionPath) {
    console.log(`Mode: Extension (${config.extensionPath})`);
    if (config.extensionUrl) console.log(`URL: ${config.extensionUrl}`);
  }
  if (config.bedrockApiKey) {
    console.log(`Provider: Bedrock CAMP (model ${config.bedrockModelId ?? 'default'})`);
  } else if (config.adobeToken) {
    console.log(`Provider: Adobe (token ${config.adobeToken.slice(0, 8)}...)`);
  }
  console.log('');

  const controllers: InstanceController[] = [];
  for (let i = 0; i < config.instances; i++) {
    controllers.push(
      new InstanceController({
        index: i,
        port: config.basePort + i * 10,
        scenario: assigned[i]!,
        timeoutMs: config.timeoutSeconds * 1000,
        envFile: config.envFile,
        adobeToken: config.adobeToken,
        modelId: config.modelId,
        bedrockApiKey: config.bedrockApiKey,
        bedrockBaseUrl: config.bedrockBaseUrl,
        bedrockModelId: config.bedrockModelId,
        extensionPath: config.extensionPath,
        extensionUrl: config.extensionUrl,
      })
    );
  }

  // Ctrl-C: gracefully abort all instances
  let shuttingDown = false;
  process.on('SIGINT', () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\nAborting all instances...');
    for (const ctrl of controllers) ctrl.abort();
  });

  // Phase 1: Boot all instances (staggered to avoid CPU spike)
  const staggerMs = 10_000;
  console.log(`Phase 1: Booting ${config.instances} instances (${staggerMs / 1000}s stagger)...\n`);

  const prepareResults = await Promise.allSettled(
    controllers.map((c, i) =>
      new Promise<void>((r) => setTimeout(r, i * staggerMs)).then(() => {
        console.log(`Booting instance ${i + 1}/${config.instances}...`);
        return c.prepare();
      })
    )
  );

  const readyCount = prepareResults.filter((r) => r.status === 'fulfilled').length;
  const failedBoot = prepareResults
    .map((r, i) => (r.status === 'rejected' ? i : -1))
    .filter((i) => i >= 0);

  console.log(`\nPhase 1 complete: ${readyCount}/${config.instances} ready`);
  if (failedBoot.length > 0) {
    console.log(`Failed to boot: ${failedBoot.map((i) => `inst-${i}`).join(', ')}`);
  }

  if (readyCount === 0) {
    console.error('No instances ready. Aborting.');
    process.exit(1);
  }

  // Wait for user confirmation before Phase 2 (skip with --no-wait)
  if (!config.noWait) {
    const triggerFile = resolve(__dirname, 'output', '.go');
    try {
      unlinkSync(triggerFile);
    } catch {
      /* may not exist */
    }
    console.log(`\nWaiting for Phase 2 trigger...`);
    console.log(`  Option A: Press ENTER in this terminal`);
    console.log(`  Option B: touch ${triggerFile}`);
    await new Promise<void>((resolve) => {
      // Stdin trigger
      process.stdin.once('data', () => resolve());
      process.stdin.resume();
      // File trigger (poll every 2s)
      const interval = setInterval(() => {
        try {
          statSync(triggerFile);
          clearInterval(interval);
          resolve();
        } catch {
          /* not yet */
        }
      }, 2000);
    });
  }

  // Phase 2: Execute scenario with random stagger over 30s
  const rampMs = 30_000;
  console.log(
    `\nPhase 2: Executing scenario on ${readyCount} instances (${rampMs / 1000}s random ramp)...\n`
  );
  const results = await Promise.all(
    controllers.map((c, i) => {
      if (prepareResults[i]?.status === 'rejected') {
        const err = (prepareResults[i] as PromiseRejectedResult).reason;
        const msg = err instanceof Error ? err.message : String(err);
        return c.execute().catch(() => ({
          index: i,
          port: config.basePort + i * 10,
          prompt: assigned[i]!.prompt,
          result: 'error' as const,
          durationMs: null,
          error: `Boot failed: ${msg}`,
        }));
      }
      const delay = Math.floor(Math.random() * rampMs);
      return new Promise<void>((r) => setTimeout(r, delay)).then(() => {
        console.log(`Starting instance ${i + 1} (delay ${(delay / 1000).toFixed(1)}s)`);
        return c.execute();
      });
    })
  );

  const report = computeReport(config, results, startedAt);
  printReport(report);

  const outDir = resolve(__dirname, 'output');
  mkdirSync(outDir, { recursive: true });
  const reportPath = resolve(outDir, `report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Full report: ${reportPath}`);

  process.exit(report.summary.passed === report.summary.total ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
