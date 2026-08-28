/**
 * `biscotto` / `biscotti` — hand someone a revocable guest seat on this cone.
 *
 * A biscotto is a private `*.sliccy.now` URL that shows the live transcript and
 * a composer. What the guest sends is reviewed before it reaches the cone, and
 * (when the seat says so) every tool call in the turn their message causes is
 * reviewed too.
 *
 * Routes through the panel-RPC `tray-mint-biscotto` / `tray-revoke-biscotto` /
 * `tray-list-biscotti` ops for the same reason `serve` does: this command runs
 * in the kernel worker, but the tray's controller token — the credential every
 * one of these routes needs — is held by the page-side leader.
 */

import type { ResolvedCommandContext } from 'just-bash';

/** Same shape the other supplemental commands return. */
type CommandResult = { stdout: string; stderr: string; exitCode: number };

import type { PanelRpcPayloadFor, PanelRpcResults } from '../../../kernel/panel-rpc.js';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';

type Gate = { approver: 'off' | 'user' | 'cone' | 'scoop'; scoop?: string };
type Gates = { message: Gate; tool: Gate };

/** Longest a seat may live, matching the worker's own ceiling. */
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function help(name: string): CommandResult {
  return {
    stdout:
      `usage: ${name} serve --label <name> [--expires <duration>]\n` +
      `                        [--gate-messages <approver>] [--gate-tools <approver>]\n` +
      `       ${name} revoke <id>\n` +
      `       biscotti\n\n` +
      '  Hand someone a revocable guest seat on this cone. They get a private\n' +
      '  URL showing the live transcript and a composer; what they send is\n' +
      '  reviewed before it reaches the cone.\n\n' +
      '  --label        Who the seat is for. Shown on every approval prompt as the\n' +
      '                 authenticated identity, beside what they actually wrote.\n' +
      '  --expires      How long the seat lives (30m, 12h, 7d). Max 30d.\n' +
      '                 Omit and it lives as long as this tray.\n' +
      '  --gate-messages Who approves each message: user (default), cone,\n' +
      '                 scoop:<name>, or off.\n' +
      '  --gate-tools   Who approves each tool call in a turn the guest caused.\n' +
      '                 Same values. `cone` is NOT available here — the cone is\n' +
      '                 the unit running the tool, so it cannot approve its own\n' +
      '                 blocked call.\n\n' +
      '  The URL is printed ONCE, at mint. A listing never returns seat tokens,\n' +
      '  so a screenshot of `biscotti` is not a set of working guest URLs.\n',
    stderr: '',
    exitCode: 0,
  };
}

/** `30m` / `12h` / `7d` / `90s`, or a bare number read as seconds. */
export function parseDuration(input: string): number | null {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const unit = (match[2] || 's').toLowerCase();
  const scale = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  return value * scale * 1000;
}

/**
 * `user` | `cone` | `off` | `scoop:<name>`.
 *
 * Returns null for anything else rather than guessing — an approver nobody
 * recognises must not quietly become a different one.
 */
export function parseApprover(input: string): Gate | null {
  const value = input.trim();
  if (value === 'user' || value === 'cone' || value === 'off') return { approver: value };
  const scoop = /^scoop:(.+)$/.exec(value);
  return scoop?.[1] ? { approver: 'scoop', scoop: scoop[1].trim() } : null;
}

/**
 * One `--gate-*` flag, or the error to show. Split out of `parseServeArgs` so
 * the option loop stays a flat table of flags.
 */
function readGateFlag(flag: string, raw: string | undefined): Gate | string {
  if (!raw) return `${flag} needs an approver (user, cone, scoop:<name>, off)`;
  const gate = parseApprover(raw);
  if (!gate) return `${flag}: cannot read "${raw}" as an approver`;
  if (flag === '--gate-tools' && gate.approver === 'cone') {
    // Refused at configuration time rather than discovered as a stalled
    // approval: for a tool call the cone is the unit executing it, so it would
    // be asked to approve something it is itself blocked on.
    return '--gate-tools cone: the cone cannot approve a tool call it is blocked on; use user, scoop:<name>, or off';
  }
  return gate;
}

interface ParsedServe {
  label: string;
  ttlMs?: number;
  gates: Gates;
}

/**
 * Parse `biscotto serve` argv. Returns a string on failure — the message the
 * user sees, so it explains what was wrong rather than restating the grammar.
 */
export function parseServeArgs(args: string[]): ParsedServe | string {
  let label: string | undefined;
  let ttlMs: number | undefined;
  const gates: Gates = { message: { approver: 'user' }, tool: { approver: 'user' } };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = (): string | undefined => args[++i];
    switch (arg) {
      case '--label': {
        label = next();
        if (!label) return '--label needs a name';
        break;
      }
      case '--expires': {
        const raw = next();
        if (!raw) return '--expires needs a duration (30m, 12h, 7d)';
        const parsed = parseDuration(raw);
        if (parsed === null) return `--expires: cannot read "${raw}" as a duration`;
        if (parsed > MAX_TTL_MS) return '--expires cannot exceed 30d';
        ttlMs = parsed;
        break;
      }
      case '--gate-messages':
      case '--gate-tools': {
        const gate = readGateFlag(arg, next());
        if (typeof gate === 'string') return gate;
        if (arg === '--gate-messages') gates.message = gate;
        else gates.tool = gate;
        break;
      }
      default:
        return `unknown option: ${arg}`;
    }
  }
  if (!label) return '--label is required: say who the seat is for';
  return { label, ttlMs, gates };
}

function describeGate(gate: Gate): string {
  if (gate.approver === 'scoop') return `scoop:${gate.scoop ?? '?'}`;
  return gate.approver;
}

function rpc() {
  const client = getPanelRpcClient();
  if (!client) {
    throw new Error(
      'no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.'
    );
  }
  return client;
}

function formatList(biscotti: PanelRpcResults['tray-list-biscotti']['biscotti']): string {
  if (biscotti.length === 0) return 'No biscotti on this cone.\n';
  const rows = biscotti.map((seat) => {
    const state = seat.revokedAt ? 'revoked' : seat.active ? 'active' : 'expired';
    const seen = seat.lastSeenAt ? `last seen ${seat.lastSeenAt}` : 'never connected';
    const expiry = seat.expiresAt ? `expires ${seat.expiresAt}` : 'no expiry';
    return (
      `${seat.id}  ${seat.label}\n` +
      `    ${state} · ${expiry} · ${seen}\n` +
      `    messages: ${describeGate(seat.gates.message)} · tools: ${describeGate(seat.gates.tool)}\n`
    );
  });
  // Deliberately no URLs: seat tokens are never returned by a listing, so a
  // screenshot of this is not a set of working guest URLs.
  return `${rows.join('')}\nSeat URLs are shown only at mint and cannot be recovered here.\n`;
}

export async function runBiscotto(
  name: string,
  args: string[],
  _ctx: ResolvedCommandContext
): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({
    stdout: '',
    stderr: `${name}: ${message}\n`,
    exitCode: 1,
  });

  try {
    // `--help` ANYWHERE wins, before any verb dispatch and before a single
    // dependency is touched: `biscotto serve --help` must print help, not mint
    // a seat and then explain what it did (review pattern: "--help that does
    // the thing"). The panel-RPC client is never even reached on this path.
    if (args.includes('--help') || args.includes('-h') || args[0] === 'help') return help(name);

    // `biscotti` is the plural spelling of the listing — `biscotti` with no
    // args lists, exactly as `biscotto list` would.
    const listing = name === 'biscotti' && args.length === 0;
    const [verb, ...rest] = listing ? ['list'] : args;

    if (!verb) return help(name);

    switch (verb) {
      case 'serve': {
        const parsed = parseServeArgs(rest);
        if (typeof parsed === 'string') return fail(parsed);
        const payload: PanelRpcPayloadFor<'tray-mint-biscotto'> = {
          label: parsed.label,
          ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
          gates: parsed.gates,
        };
        const seat = await rpc().call('tray-mint-biscotto', payload);
        return {
          stdout:
            `biscotto ${seat.id} for ${seat.label}\n\n  ${seat.url}\n\n` +
            `  messages: ${describeGate(seat.gates.message)} · tools: ${describeGate(seat.gates.tool)}\n` +
            (seat.expiresAt ? `  expires ${seat.expiresAt}\n` : '  no expiry\n') +
            `\nThis URL is shown once. Revoke with \`biscotto revoke ${seat.id}\`.\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      case 'revoke': {
        const id = rest[0];
        if (!id) return fail('revoke needs a biscotto id (see `biscotti`)');
        const result = await rpc().call('tray-revoke-biscotto', { id });
        // `evicted: false` means the token is dead for future joins but the
        // leader could not be told to close a live channel. Saying "revoked"
        // there would tell the owner the guest is out when they may not be.
        const note =
          result.evicted === false
            ? '\nWARNING: the leader could not be reached, so anyone already connected on this ' +
              'seat may still hold an open channel. No new joins are possible.\n'
            : '';
        return { stdout: `biscotto ${result.id} revoked.\n${note}`, stderr: '', exitCode: 0 };
      }
      case 'list': {
        const { biscotti } = await rpc().call('tray-list-biscotti', undefined);
        return { stdout: formatList(biscotti), stderr: '', exitCode: 0 };
      }
      default:
        return fail(`unknown subcommand: ${verb}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
