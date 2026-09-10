/**
 * `session` shell command — export, and (Memory v2) search/read over archives.
 *
 * Syntax:
 *   session export [--id <frozen-session-id>] [--output <path>]
 *   session search <query> [--limit N]          # memory-v2 only
 *   session read <id> [--from N --count M]      # memory-v2 only
 *
 * Default export output: /workspace/slicc-transcript-<session-id>.zip
 * Search/read are gated by the `memory-v2` feature flag and stay absent
 * from help when the flag is off. Memory v2 handlers load on first use so
 * they stay out of the kernel-worker first-load eager graph.
 */

import { TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getTranscriptExportService } from '../../transcript/export-provider.js';
import type { TranscriptSessionSelector } from '../../transcript/export-service.js';
import type { TranscriptZipResult } from '../../transcript/zip-stream.js';
import { isHelpRequest } from './subcommand-help.js';

const EXPORT_USAGE = 'usage: session export [--id <id>] [--output <path>]\n';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

interface ParsedExportArgs {
  sessionId: string | null;
  outputPath: string | null;
}

type ParseResult = { ok: true; args: ParsedExportArgs } | { ok: false; stderr: string };

/**
 * Reject --output paths that could escape VFS containment.
 * Allows normal absolute VFS paths; rejects NUL, backslash, and dot-segment traversal.
 */
function validateOutputPath(path: string): { ok: true } | { ok: false; reason: string } {
  if (path.includes('\x00')) return { ok: false, reason: 'path must not contain NUL bytes' };
  if (path.includes('\\')) return { ok: false, reason: 'path must not contain backslashes' };
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..') return { ok: false, reason: 'path must not contain ".."/traversal segments' };
  }
  return { ok: true };
}

function parseExportArgs(args: readonly string[]): ParseResult {
  let sessionId: string | null = null;
  let outputPath: string | null = null;
  const rest = args.slice(1); // drop the 'export' subcommand token

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--id') {
      if (sessionId !== null) {
        return { ok: false, stderr: `session export: duplicate flag --id\n${EXPORT_USAGE}` };
      }
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return {
          ok: false,
          stderr: `session export: --id requires a value\n${EXPORT_USAGE}`,
        };
      }
      sessionId = val;
      i++;
    } else if (flag === '--output') {
      if (outputPath !== null) {
        return { ok: false, stderr: `session export: duplicate flag --output\n${EXPORT_USAGE}` };
      }
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return {
          ok: false,
          stderr: `session export: --output requires a path\n${EXPORT_USAGE}`,
        };
      }
      outputPath = val;
      i++;
    } else if (flag.startsWith('-')) {
      return {
        ok: false,
        stderr: `session export: unknown flag ${flag}\n${EXPORT_USAGE}`,
      };
    } else {
      return {
        ok: false,
        stderr: `session export: unexpected argument ${JSON.stringify(flag)}\n${EXPORT_USAGE}`,
      };
    }
  }

  return { ok: true, args: { sessionId, outputPath } };
}

async function collectAndVerify(result: TranscriptZipResult): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  for await (const chunk of result.chunks) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const completion = await result.completion;
  if (completion.byteLength !== byteLength) {
    throw new TranscriptExportError('transfer-corrupt');
  }

  const actualSha256 = sha256(merged);
  if (actualSha256 !== completion.sha256) {
    throw new TranscriptExportError('transfer-corrupt');
  }

  return merged;
}

async function runExport(args: readonly string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseExportArgs(args);
  if (!parsed.ok) {
    return { stdout: '', stderr: parsed.stderr, exitCode: 1 };
  }

  const { sessionId, outputPath } = parsed.args;

  if (outputPath !== null) {
    const pathCheck = validateOutputPath(outputPath);
    if (!pathCheck.ok) {
      return {
        stdout: '',
        stderr: `session export: --output ${pathCheck.reason}\n${EXPORT_USAGE}`,
        exitCode: 1,
      };
    }
  }

  const selector: TranscriptSessionSelector =
    sessionId != null ? { kind: 'frozen', sessionId } : { kind: 'active' };

  try {
    const service = getTranscriptExportService();
    const result = await service.export(selector, {});
    const bytes = await collectAndVerify(result);
    const resolvedOutput = outputPath ?? `/workspace/${result.filename}`;
    await ctx.fs.writeFile(resolvedOutput, bytes);
    return { stdout: `exported ${resolvedOutput}\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    const message =
      err instanceof TranscriptExportError
        ? err.code
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      stdout: '',
      stderr: `session export: ${message}\n`,
      exitCode: 1,
    };
  }
}

async function memoryV2Enabled(): Promise<boolean> {
  const { isMemoryV2Enabled } = await import('../../transcript/memory-v2-flag.js');
  return isMemoryV2Enabled();
}

function unknownSubcommandOff(sub: string | undefined): string {
  return (
    `session export: unknown subcommand ${JSON.stringify(sub ?? '')}` +
    ` — usage: session export [--id <id>] [--output <path>]\n`
  );
}

function unknownSubcommandOn(sub: string | undefined): string {
  return (
    `session: unknown subcommand ${JSON.stringify(sub ?? '')}` +
    ` — usage: session export|search|read (see session --help)\n`
  );
}

export function createSessionCommand(): Command {
  return defineCommand('session', async (args, ctx) => {
    if (isHelpRequest(args)) {
      if (!(await memoryV2Enabled())) {
        return { stdout: EXPORT_USAGE, stderr: '', exitCode: 0 };
      }
      const { runSessionMemoryVerb } = await import('./session-command-memory.js');
      const sub = args[0];
      const helpSub = sub && sub !== '--help' && sub !== '-h' ? sub : undefined;
      return runSessionMemoryVerb('help', args, ctx, helpSub);
    }

    const sub = args[0];

    if (sub === 'export') return runExport(args, ctx);

    if (sub === 'search' || sub === 'read') {
      if (!(await memoryV2Enabled())) {
        return { stdout: '', stderr: unknownSubcommandOff(sub), exitCode: 1 };
      }
      const { runSessionMemoryVerb } = await import('./session-command-memory.js');
      return runSessionMemoryVerb(sub, args, ctx);
    }

    const on = await memoryV2Enabled();
    return {
      stdout: '',
      stderr: on ? unknownSubcommandOn(sub) : unknownSubcommandOff(sub),
      exitCode: 1,
    };
  });
}
