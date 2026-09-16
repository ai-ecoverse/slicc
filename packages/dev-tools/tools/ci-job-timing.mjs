import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTimingReport, formatTimingSummary, selectJob } from './ci-job-timing-lib.mjs';

function parseArgs(args) {
  const options = { excludedSteps: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--job') options.job = args[++index];
    else if (value === '--title') options.title = args[++index];
    else if (value === '--output') options.output = args[++index];
    else if (value === '--exclude-step') options.excludedSteps.push(args[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.job) throw new Error('Usage: ci-job-timing.mjs --job <job name> [--title <title>]');
  return options;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function listJobs() {
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const runId = requiredEnv('GITHUB_RUN_ID');
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GH_TOKEN or GITHUB_TOKEN');

  const response = await fetch(
    `${apiUrl}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?filter=latest&per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!response.ok) throw new Error(`GitHub jobs API returned HTTP ${response.status}`);
  const payload = await response.json();
  return payload.jobs ?? [];
}

function defaultOutput(jobName) {
  const slug = jobName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return `test-results/${slug}-phase-timing.json`;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  let jobs = [];
  let job;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    jobs = await listJobs();
    job = selectJob(jobs, options.job);
    if (job) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  if (!job) {
    const names = jobs
      .map((candidate) => candidate.name)
      .filter(Boolean)
      .join(', ');
    throw new Error(`Job ${JSON.stringify(options.job)} not found in this run. Found: ${names}`);
  }

  const report = buildTimingReport(job, { excludedSteps: options.excludedSteps });
  const output = options.output ?? defaultOutput(options.job);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  const summary = formatTimingSummary(report, options.title);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}`);
  process.stdout.write(summary);
  process.stdout.write(`Timing JSON: ${output}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
