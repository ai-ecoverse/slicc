import type { ExecResult, ResolvedCommandContext } from 'just-bash';
import { readSliccVersion } from '../../../base/slicc-version.js';
import type { FilePatch, HunkOutcome } from '../../../git/patch-core.js';
import {
  applyPatch,
  DEV_NULL,
  formatRejects,
  isCreation,
  isDeletion,
  parseUnifiedDiff,
  reversePatch,
} from '../../../git/patch-core.js';
import { stdinAsText } from '../../just-bash-compat.js';
import { PATCH_USAGE, type PatchArgs, PatchUsageError, parsePatchArgs } from './args.js';

const HELP = `${PATCH_USAGE}

Apply a unified diff to files in the SLICC virtual filesystem. The patch is
read from PATCHFILE, from -i, or from standard input.

Options:
  -p NUM, --strip=NUM   Strip NUM leading path components from names in the
                        patch. Omitted: try the name as written, then strip one
                        component at a time, and use the first that exists.
  -R, --reverse         Assume the patch was made with old and new swapped.
  -F NUM, --fuzz=NUM    Context lines the matcher may ignore (default 2).
  --dry-run             Report what would happen; write nothing.
  -s, --silent, --quiet Print only errors.
  -i FILE, --input=FILE Read the patch from FILE instead of stdin.
  --help                This text.
  --version             Print the SLICC build this patch ships in.

Hunks are located by searching outward from their recorded line, so a patch
still applies to a file that has drifted. Hunks that cannot be placed are
written to FILE.rej and the exit status is 1.
`;

interface Report {
  stdout: string[];
  stderr: string[];

  exitCode: number;
}

function finish(report: Report): ExecResult {
  const stdout = report.stdout.length > 0 ? `${report.stdout.join('\n')}\n` : '';
  const stderr = report.stderr.length > 0 ? `${report.stderr.join('\n')}\n` : '';
  return { stdout, stderr, exitCode: report.exitCode };
}

function fail(message: string, code = 2): ExecResult {
  return { stdout: '', stderr: `patch: ${message}\n`, exitCode: code };
}

export function stripComponents(name: string, count: number): string | null {
  if (name === DEV_NULL) return null;
  const parts = name.replace(/^\/+/, '').split('/');
  if (count >= parts.length) return null;
  return parts.slice(count).join('/');
}

export function stripCandidates(name: string): string[] {
  if (name === DEV_NULL) return [];
  const parts = name.replace(/^\/+/, '').split('/');
  return parts.map((_, index) => parts.slice(index).join('/'));
}

export interface TargetLookup {
  exists(path: string): Promise<boolean>;
  resolve(path: string): string;
}

function parentOf(candidate: string): string {
  const slash = candidate.lastIndexOf('/');
  return slash === -1 ? '.' : candidate.slice(0, slash);
}

async function autoTarget(candidates: string[], lookup: TargetLookup): Promise<string | null> {
  for (const candidate of candidates) {
    if (await lookup.exists(lookup.resolve(candidate))) return candidate;
  }
  for (const candidate of candidates) {
    if (await lookup.exists(lookup.resolve(parentOf(candidate)))) return candidate;
  }
  return candidates.at(-1) ?? null;
}

export async function resolveTarget(
  patch: FilePatch,
  strip: number | null,
  lookup: TargetLookup
): Promise<string | null> {
  const names = isDeletion(patch)
    ? [patch.oldName]
    : [patch.newName, patch.oldName].filter((name) => name !== DEV_NULL);
  if (strip !== null) {
    for (const name of names) {
      const stripped = stripComponents(name, strip);
      if (stripped !== null) return stripped;
    }
    return null;
  }
  return autoTarget(names.flatMap(stripCandidates), lookup);
}

function describeOutcome(outcome: HunkOutcome): string {
  const notes: string[] = [];
  if (outcome.fuzz > 0) notes.push(`with fuzz ${outcome.fuzz}`);
  if (outcome.offset !== 0) {
    const lines = Math.abs(outcome.offset) === 1 ? 'line' : 'lines';
    notes.push(`(offset ${outcome.offset} ${lines})`);
  }
  const suffix = notes.length > 0 ? ` ${notes.join(' ')}` : '';
  return `Hunk #${outcome.index} succeeded at ${outcome.line}${suffix}.`;
}

async function readSource(
  ctx: ResolvedCommandContext,
  path: string,
  patch: FilePatch
): Promise<string | { missing: true }> {
  try {
    return await ctx.fs.readFile(path);
  } catch {
    return isCreation(patch) ? '' : { missing: true };
  }
}

async function writeResult(
  ctx: ResolvedCommandContext,
  path: string,
  text: string,
  patch: FilePatch
): Promise<void> {
  if (isDeletion(patch) && text === '') {
    await ctx.fs.rm(path, { force: true });
    return;
  }
  await ctx.fs.writeFile(path, text);
}

async function patchOneFile(
  ctx: ResolvedCommandContext,
  patch: FilePatch,
  args: PatchArgs,
  report: Report
): Promise<void> {
  const relative =
    args.originalFile ??
    (await resolveTarget(patch, args.strip, {
      exists: (path) => ctx.fs.exists(path),
      resolve: (path) => ctx.fs.resolvePath(ctx.cwd, path),
    }));
  if (relative === null) {
    report.stderr.push(`patch: **** can't determine which file to patch from ${patch.newName}`);
    report.exitCode = Math.max(report.exitCode, 2);
    return;
  }
  const path = ctx.fs.resolvePath(ctx.cwd, relative);
  const source = await readSource(ctx, path, patch);
  if (typeof source !== 'string') {
    report.stderr.push(`patch: **** can't find file to patch: ${relative}`);
    report.exitCode = Math.max(report.exitCode, 2);
    return;
  }

  if (!args.silent) {
    report.stdout.push(`${args.dryRun ? 'checking' : 'patching'} file ${relative}`);
  }
  const result = applyPatch(source, patch, { fuzz: args.fuzz });
  for (const outcome of result.outcomes) {
    if (outcome.applied) {
      if (!args.silent && (outcome.offset !== 0 || outcome.fuzz > 0)) {
        report.stdout.push(describeOutcome(outcome));
      }
      continue;
    }
    report.stderr.push(`Hunk #${outcome.index} FAILED at ${outcome.line}.`);
  }

  if (!args.dryRun && result.rejected.length < patch.hunks.length) {
    await writeResult(ctx, path, result.text, patch);
  }
  if (result.rejected.length > 0) {
    report.exitCode = Math.max(report.exitCode, 1);
    const rejectPath = `${relative}.rej`;
    report.stderr.push(
      `${result.rejected.length} out of ${patch.hunks.length} hunks FAILED` +
        (args.dryRun ? '' : ` -- saving rejects to file ${rejectPath}`)
    );
    if (!args.dryRun) {
      await ctx.fs.writeFile(
        ctx.fs.resolvePath(ctx.cwd, rejectPath),
        formatRejects(patch, result.rejected)
      );
    }
  }
}

async function readPatchText(
  ctx: ResolvedCommandContext,
  args: PatchArgs
): Promise<string | { error: string }> {
  if (args.patchFile === undefined || args.patchFile === '-') return stdinAsText(ctx.stdin);
  try {
    return await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, args.patchFile));
  } catch {
    return { error: `${args.patchFile}: No such file or directory` };
  }
}

export async function runPatch(
  rawArgs: string[],
  ctx: ResolvedCommandContext
): Promise<ExecResult> {
  let args: PatchArgs;
  try {
    args = parsePatchArgs(rawArgs);
  } catch (error) {
    const message = error instanceof PatchUsageError ? error.message : String(error);
    return { stdout: '', stderr: `patch: ${message}\n${PATCH_USAGE}\n`, exitCode: 2 };
  }
  if (args.mode === 'help') return { stdout: HELP, stderr: '', exitCode: 0 };
  if (args.mode === 'version') {
    return { stdout: `patch (SLICC) ${readSliccVersion().version}\n`, stderr: '', exitCode: 0 };
  }

  const text = await readPatchText(ctx, args);
  if (typeof text !== 'string') return fail(text.error);

  const parsed = parseUnifiedDiff(text);
  if (parsed.length === 0) {
    return fail(
      text.trim() === ''
        ? '**** empty patch input (expected a unified diff on stdin or in -i FILE)'
        : '**** only garbage was found in the patch input'
    );
  }
  if (args.originalFile !== undefined && parsed.length > 1) {
    return fail('**** a named FILE operand cannot be used with a multi-file patch');
  }

  const report: Report = { stdout: [], stderr: [], exitCode: 0 };
  for (const file of parsed) {
    const patch = args.reverse ? reversePatch(file) : file;
    await patchOneFile(ctx, patch, args, report);
  }
  return finish(report);
}
