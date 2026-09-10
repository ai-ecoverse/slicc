/**
 * upskill — `list` subcommand.
 *
 * Default listing answers "what can I use right now" (including provenance-less
 * skills). `--outdated` answers "what would a bare `upskill update` change" by
 * reusing `collectSkillUpdateResults` — the same classification `update
 * --dry-run` already performs. Unknown flags are rejected: silently discarding
 * them is how `list --outdated` used to report a confident false negative.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import { formatDiscoveredSkills, formatDiscoveryScope } from './help.js';
import { collectSkillUpdateResults, type SkillUpdateResult } from './update.js';

interface ParsedListArgs {
  outdated: boolean;
  json: boolean;
  error?: string;
}

function parseListArgs(args: string[]): ParsedListArgs {
  const parsed: ParsedListArgs = { outdated: false, json: false };
  for (const arg of args) {
    if (arg === '--outdated') parsed.outdated = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg.startsWith('-')) {
      parsed.error = `upskill: unknown option "${arg}" for list`;
      return parsed;
    } else {
      parsed.error = `upskill: unexpected argument "${arg}" for list`;
      return parsed;
    }
  }
  return parsed;
}

function shaRange(result: SkillUpdateResult): string {
  if (result.to && result.from && result.to !== result.from) {
    return `  ${result.from.slice(0, 7)} → ${result.to.slice(0, 7)}`;
  }
  if (result.to) return `  ${result.to.slice(0, 7)}`;
  return '';
}

function formatOutdatedHuman(results: SkillUpdateResult[], skipped: string[]): string {
  const outdated = results.filter((r) => r.outcome === 'updated');
  const lines: string[] = [];
  if (outdated.length === 0) {
    lines.push('No outdated skills.');
  } else {
    lines.push('Outdated skills:', '');
    for (const result of outdated) {
      lines.push(`  ${result.skill}  ${result.source}${shaRange(result)}`);
    }
  }
  if (skipped.length > 0) {
    const noun = skipped.length === 1 ? 'skill' : 'skills';
    lines.push('', `Skipped ${skipped.length} ${noun} with no install provenance — not checked.`);
  }
  const failures = results.filter((r) => r.outcome === 'error');
  if (failures.length > 0) {
    const noun = failures.length === 1 ? 'skill' : 'skills';
    lines.push('', `Could not check ${failures.length} ${noun}:`);
    for (const result of failures) {
      lines.push(`  ${result.skill}: failed — ${result.error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function listDiscoverable(
  fs: VirtualFS,
  json: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const skills = await import('../../../skills/index.js');
  const discovered = await skills.discoverSkills(fs);
  if (json) {
    return {
      stdout: `${JSON.stringify({ ok: true, skills: discovered })}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  if (discovered.length === 0) {
    return {
      stdout: `No discoverable local skills found.\n\n${formatDiscoveryScope()}`,
      stderr: '',
      exitCode: 0,
    };
  }
  return {
    stdout: formatDiscoveredSkills(discovered, 'Discoverable local skills'),
    stderr: '',
    exitCode: 0,
  };
}

async function listOutdated(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  json: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { results, skipped } = await collectSkillUpdateResults(fs, fetchFn, {
    skills: [],
    dryRun: true,
  });
  const outdated = results.filter((r) => r.outcome === 'updated');
  const failures = results.filter((r) => r.outcome === 'error');
  // Staleness is information (exit 0), matching `update --dry-run`. A check
  // that could not run is not: scripted callers must be able to tell "nothing
  // stale" from "we could not look". Same `ok` / stderr / exit as update.
  const ok = failures.length === 0;
  const stderr = failures.map((r) => `upskill: ${r.skill}: ${r.error}\n`).join('');
  if (json) {
    return {
      stdout: `${JSON.stringify({ ok, results: [...outdated, ...failures], skipped })}\n`,
      stderr,
      exitCode: ok ? 0 : 1,
    };
  }
  return {
    stdout: formatOutdatedHuman(results, skipped),
    stderr,
    exitCode: ok ? 0 : 1,
  };
}

/**
 * `upskill list [--outdated] [--json]`
 *
 * Exit 0 whether or not anything is stale — staleness is information, not
 * failure. A skill whose check itself failed still exits 1, matching
 * `update --dry-run`.
 */
export async function handleUpskillList(
  args: string[],
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const parsed = parseListArgs(args);
  if (parsed.error) {
    return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 1 };
  }
  return parsed.outdated
    ? listOutdated(fs, fetchFn, parsed.json)
    : listDiscoverable(fs, parsed.json);
}
