/**
 * Memory v2 `session search` / `session read` handlers.
 *
 * Loaded on first use so the search help text and MiniSearch path stay out of
 * the kernel-worker first-load eager graph (`first-load-budget.json`).
 */

import type { CommandContext } from 'just-bash';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

export const MEMORY_V2_HELP = `session — export and search session archives

  export [--id <id>] [--output <path>]
      Export a transcript ZIP (active session, or a frozen archive by id).
      Default output: /workspace/slicc-transcript-<id>.zip

  search <query> [--limit N]
      Keyword search over /sessions archives (title weighted 4× body).
      Returns bounded excerpts with stable ids for session read.

  read <id> [--from N --count M]
      Read a bounded page of messages for a search hit id
      (sess/<sessionId>/msg/<messageId>). Hard-capped page size.
`;

type CommandResult = { stdout: string; stderr: string; exitCode: number };

function parseSearchArgs(
  args: readonly string[]
): { ok: true; query: string; limit?: number } | { ok: false; stderr: string } {
  const rest = args.slice(1);
  let limit: number | undefined;
  const queryParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok === '--limit') {
      const val = rest[i + 1];
      if (!val || val.startsWith('-')) {
        return { ok: false, stderr: 'session search: --limit requires a number\n' };
      }
      const n = Number(val);
      if (!Number.isFinite(n) || n < 1) {
        return { ok: false, stderr: 'session search: --limit must be a positive integer\n' };
      }
      limit = Math.floor(n);
      i++;
    } else if (tok.startsWith('-')) {
      return { ok: false, stderr: `session search: unknown flag ${tok}\n` };
    } else {
      queryParts.push(tok);
    }
  }
  const query = queryParts.join(' ').trim();
  if (!query) {
    return {
      ok: false,
      stderr: 'session search: missing query\nusage: session search <query> [--limit N]\n',
    };
  }
  return { ok: true, query, limit };
}

function parseNonNegInt(
  val: string | undefined,
  flag: string,
  min: number
): { ok: true; n: number } | { ok: false; stderr: string } {
  if (!val || val.startsWith('-')) {
    return { ok: false, stderr: `session read: ${flag} requires a number\n` };
  }
  const n = Number(val);
  if (!Number.isFinite(n) || n < min) {
    const kind = min === 0 ? 'a non-negative integer' : 'a positive integer';
    return { ok: false, stderr: `session read: ${flag} must be ${kind}\n` };
  }
  return { ok: true, n: Math.floor(n) };
}

function parseReadArgs(
  args: readonly string[]
): { ok: true; id: string; from?: number; count?: number } | { ok: false; stderr: string } {
  const rest = args.slice(1);
  let id: string | undefined;
  let from: number | undefined;
  let count: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok === '--from' || tok === '--count') {
      const parsed = parseNonNegInt(rest[i + 1], tok, tok === '--from' ? 0 : 1);
      if (!parsed.ok) return parsed;
      if (tok === '--from') from = parsed.n;
      else count = parsed.n;
      i++;
    } else if (tok.startsWith('-')) {
      return { ok: false, stderr: `session read: unknown flag ${tok}\n` };
    } else if (id === undefined) {
      id = tok;
    } else {
      return {
        ok: false,
        stderr: `session read: unexpected argument ${JSON.stringify(tok)}\n`,
      };
    }
  }
  if (!id) {
    return {
      ok: false,
      stderr: 'session read: missing id\nusage: session read <id> [--from N --count M]\n',
    };
  }
  return { ok: true, id, from, count };
}

async function runSearch(args: readonly string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseSearchArgs(args);
  if (!parsed.ok) return { stdout: '', stderr: parsed.stderr, exitCode: 1 };

  try {
    const { searchSessions } = await import('../../transcript/session-search-index.js');
    const hits = await searchSessions(ctx.fs as never, parsed.query, {
      limit: parsed.limit,
    });
    if (hits.length === 0) {
      return {
        stdout: `# session search: ${parsed.query} (0 hits)\nNo matching messages in /sessions.\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    const lines = [`# session search: ${parsed.query} (${hits.length} hits)`];
    for (const hit of hits) {
      lines.push(
        `id=${hit.id}  score=${hit.score.toFixed(2)}  kind=${hit.echoKind}  role=${hit.role}`
      );
      lines.push(`  session=${JSON.stringify(hit.sessionTitle)}  path=${hit.path}`);
      lines.push(`  ${hit.excerpt}`);
      lines.push('');
    }
    lines.push('Use: session read <id> [--from N --count M]');
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `session search: ${message}\n`, exitCode: 1 };
  }
}

async function runRead(args: readonly string[], ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseReadArgs(args);
  if (!parsed.ok) return { stdout: '', stderr: parsed.stderr, exitCode: 1 };

  try {
    const { readSessionHit, SESSION_READ_BYTE_CAP } = await import(
      '../../transcript/session-search-index.js'
    );
    const page = await readSessionHit(ctx.fs as never, parsed.id, {
      from: parsed.from,
      count: parsed.count,
    });
    if (!page) {
      return {
        stdout: '',
        stderr: `session read: unknown id ${JSON.stringify(parsed.id)}\n`,
        exitCode: 1,
      };
    }
    const header =
      `# session read: ${parsed.id}\n` +
      `path=${page.hit.path}  title=${JSON.stringify(page.hit.sessionTitle)}\n` +
      `messages ${page.from}–${page.from + page.count - 1} of ${page.total}` +
      `  (remaining: ${page.remaining}` +
      `${page.truncated ? ', truncated to byte cap' : ''})\n` +
      `byteCap=${SESSION_READ_BYTE_CAP}\n\n`;
    return { stdout: header + page.text, stderr: '', exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `session read: ${message}\n`, exitCode: 1 };
  }
}

/** Dispatch Memory v2 help / search / read (caller already checked the flag). */
export async function runSessionMemoryVerb(
  sub: 'search' | 'read' | 'help',
  args: readonly string[],
  ctx: CommandContext,
  helpSub?: string
): Promise<CommandResult> {
  if (sub === 'help') {
    const text = helpSub ? subcommandHelpText('session', helpSub, MEMORY_V2_HELP) : MEMORY_V2_HELP;
    return { stdout: text, stderr: '', exitCode: 0 };
  }
  if (isHelpRequest(args.slice(1))) {
    return {
      stdout: subcommandHelpText('session', sub, MEMORY_V2_HELP),
      stderr: '',
      exitCode: 0,
    };
  }
  return sub === 'search' ? runSearch(args, ctx) : runRead(args, ctx);
}
