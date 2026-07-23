/**
 * `session` shell command — export a transcript bundle to the VFS.
 *
 * Syntax:
 *   session export [--id <frozen-session-id>] [--output <path>]
 *
 * Default output: /workspace/slicc-transcript-<session-id>.zip
 * Chunks are streamed into memory, verified against the completion receipt
 * (byteLength), then written once via ctx.fs.writeFile.
 * Errors are prefixed `session export:` and exit 1.
 */

import { TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getTranscriptExportService } from '../../transcript/export-provider.js';
import type { TranscriptSessionSelector } from '../../transcript/export-service.js';
import type { TranscriptZipResult } from '../../transcript/zip-stream.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedExportArgs {
  sessionId: string | null;
  outputPath: string | null;
}

type ParseResult = { ok: true; args: ParsedExportArgs } | { ok: false; stderr: string };

const USAGE = 'usage: session export [--id <id>] [--output <path>]\n';

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
        return { ok: false, stderr: `session export: duplicate flag --id\n${USAGE}` };
      }
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return {
          ok: false,
          stderr: `session export: --id requires a value\n${USAGE}`,
        };
      }
      sessionId = val;
      i++;
    } else if (flag === '--output') {
      if (outputPath !== null) {
        return { ok: false, stderr: `session export: duplicate flag --output\n${USAGE}` };
      }
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return {
          ok: false,
          stderr: `session export: --output requires a path\n${USAGE}`,
        };
      }
      outputPath = val;
      i++;
    } else if (flag.startsWith('-')) {
      return {
        ok: false,
        stderr: `session export: unknown flag ${flag}\n${USAGE}`,
      };
    } else {
      return {
        ok: false,
        stderr: `session export: unexpected argument ${JSON.stringify(flag)}\n${USAGE}`,
      };
    }
  }

  return { ok: true, args: { sessionId, outputPath } };
}

// ---------------------------------------------------------------------------
// Chunk collection + verification
// ---------------------------------------------------------------------------

async function collectAndVerify(result: TranscriptZipResult): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  for await (const chunk of result.chunks) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }

  // Merge chunks into a single buffer before verification
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

  // SHA-256 content integrity check — catches corruption that byteLength alone cannot.
  const actualSha256 = sha256(merged);
  if (actualSha256 !== completion.sha256) {
    throw new TranscriptExportError('transfer-corrupt');
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createSessionCommand(): Command {
  return defineCommand('session', async (args, ctx) => {
    const sub = args[0];

    if (sub !== 'export') {
      return {
        stdout: '',
        stderr:
          `session export: unknown subcommand ${JSON.stringify(sub ?? '')}` +
          ` — usage: session export [--id <id>] [--output <path>]\n`,
        exitCode: 1,
      };
    }

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
          stderr: `session export: --output ${pathCheck.reason}\n${USAGE}`,
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
      // Resolve default output from the service-returned filename so active
      // sessions get their real session id, not a client-side timestamp.
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
  });
}
