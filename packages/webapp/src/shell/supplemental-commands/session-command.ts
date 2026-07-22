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

function parseExportArgs(args: readonly string[]): ParseResult {
  let sessionId: string | null = null;
  let outputPath: string | null = null;
  const rest = args.slice(1); // drop the 'export' subcommand token

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--id') {
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return {
          ok: false,
          stderr: `session export: --id requires a value\n`,
        };
      }
      sessionId = val;
      i++;
    } else if (flag === '--output') {
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return {
          ok: false,
          stderr: `session export: --output requires a path\n`,
        };
      }
      outputPath = val;
      i++;
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

  const completion = await result.completion;
  if (completion.byteLength !== byteLength) {
    throw new TranscriptExportError('transfer-corrupt');
  }

  // Merge chunks into a single buffer
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
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

    const selector: TranscriptSessionSelector =
      sessionId != null ? { kind: 'frozen', sessionId } : { kind: 'active' };

    const resolvedId = sessionId ?? `session-${Date.now()}`;
    const resolvedOutput = outputPath ?? `/workspace/slicc-transcript-${resolvedId}.zip`;

    try {
      const service = getTranscriptExportService();
      const result = await service.export(selector, {});
      const bytes = await collectAndVerify(result);
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
