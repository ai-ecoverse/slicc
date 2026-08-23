/**
 * `ssh` — run a shell command on a connected tray follower.
 *
 * The leader (this browser) sends the command to the named follower over the
 * tray WebRTC data channel; a `slicc … follow` CLI follower runs it on its real
 * OS as the user who started it and streams stdout/stderr back. The command
 * buffers that stream and returns it like a normal `ssh host cmd` would — the
 * agent terminal renders one result per command.
 *
 * Discovery: `ssh` (no args) or `ssh --list` lists exec-capable followers, the
 * same roster the `host` command shows (a `[exec]`-tagged follower is a valid
 * target). Browser followers are never targets; iOS followers accept only a
 * restricted, non-shell command surface advertised in their MOTD.
 *
 * The shell runs in the kernel worker; the tray data channels live on the page.
 * The run bridges through the `tray-exec` panel-RPC op to
 * `LeaderSyncManager.execOnRemote`. Ctrl+C forwards a `tray-exec-signal`
 * (→ SIGINT on the follower).
 */

import { uint8ToBase64 } from '@slicc/shared-ts';
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';
import { type ConnectedFollowerInfo, getConnectedFollowersWithFallback } from './host-command.js';

/** Upper bound on how long the page bridge waits for a command (24h). */
const SSH_MAX_MS = 24 * 60 * 60 * 1000;

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function err(message: string): ExecResult {
  return { stdout: '', stderr: message.endsWith('\n') ? message : `${message}\n`, exitCode: 1 };
}

function sshHelp(): ExecResult {
  return {
    stdout: `ssh - run a command on a connected tray follower

Usage: ssh [--cwd <dir>] [--timeout <seconds>] <runtime-id> <command...>
       ssh --list

Runs <command> on the follower <runtime-id> (from \`host\` / \`ssh --list\`) and
returns its stdout, stderr, and exit code. Piped shell stdin is forwarded to the
follower (e.g. \`echo hi | ssh follower-abc123 cat\`). A \`slicc … follow\` CLI follower runs
commands on its real machine. An iOS follower accepts only
\`open [--universal|--x-callback] <url>\`, gates it through on-device scoped
approval, and launches the approved destination. \`--universal\` requires a universal
link; \`--x-callback\` writes bounded JSON and returns distinct success/error/cancel exits.

Options:
  --list, -l           List exec-capable followers and exit
  --cwd <dir>          Working directory on the follower
  --timeout <seconds>  Kill the command on the follower after this many seconds
  --help, -h           Show this help

Examples:
  ssh --list
  ssh follower-abc123 "uname -a"
  ssh --cwd /tmp follower-abc123 "ls -la"
`,
    stderr: '',
    exitCode: 0,
  };
}

function formatTargets(followers: ConnectedFollowerInfo[]): string {
  const targets = followers.filter((f) => f.exec);
  if (targets.length === 0) {
    // `follow` with no runner advertises no exec capability, so name a runner.
    return 'No exec-capable followers connected.\nStart one with: slicc <join-url> follow sh -c\n';
  }
  const lines = ['exec targets:'];
  for (const f of targets) {
    const parts = [f.runtimeId];
    if (f.runtime) parts.push(`(${f.runtime})`);
    lines.push(`  - ${parts.join(' ')}`);
    // The follower's advertised MOTD (hello.motd) — who/what/where the target
    // is, so the agent sees what it's connecting to on first `ssh --list`.
    if (f.motd) lines.push(`      ${f.motd}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Encode piped stdin for the tray exec.request wire (base64 bytes). */
function encodeStdin(ctx: CommandContext): string | undefined {
  if (ctx.stdin === undefined) return undefined;
  const latin1 = stdinAsLatin1(ctx.stdin);
  if (latin1.length === 0) return undefined;
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return uint8ToBase64(bytes);
}

interface ParsedSsh {
  list: boolean;
  cwd?: string;
  timeoutSec?: number;
  runtimeId?: string;
  command: string;
}

/** Parse leading flags, then treat the first positional as the target and the
 *  rest as the command (so flags meant for the remote command aren't eaten). */
function parseSshArgs(args: string[]): ParsedSsh | { error: string } | { help: true } {
  let list = false;
  let cwd: string | undefined;
  let timeoutSec: number | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--list' || a === '-l') {
      list = true;
      i += 1;
      continue;
    }
    if (a === '--cwd') {
      const v = args[i + 1];
      if (v === undefined) return { error: 'ssh: --cwd requires a directory argument' };
      cwd = v;
      i += 2;
      continue;
    }
    if (a === '--timeout') {
      const v = args[i + 1];
      const n = Number(v);
      if (v === undefined || !Number.isFinite(n) || n <= 0) {
        return { error: 'ssh: --timeout requires a positive number of seconds' };
      }
      timeoutSec = n;
      i += 2;
      continue;
    }
    if (a.startsWith('-') && a !== '-') return { error: `ssh: unknown flag: ${a}` };
    break;
  }
  const runtimeId = args[i];
  const command = args.slice(i + 1).join(' ');
  return { list, cwd, timeoutSec, runtimeId, command };
}

export function createSshCommand(): Command {
  return defineCommand('ssh', async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const parsed = parseSshArgs(args);
    if ('help' in parsed) return sshHelp();
    if ('error' in parsed) return err(parsed.error);

    // No target (or explicit --list) → list exec-capable followers.
    if (parsed.list || parsed.runtimeId === undefined) {
      return {
        stdout: formatTargets(getConnectedFollowersWithFallback()),
        stderr: '',
        exitCode: 0,
      };
    }
    if (!parsed.command) {
      return err('ssh: missing command\nUsage: ssh <runtime-id> <command...>');
    }

    const rpc = getPanelRpcClient();
    if (!rpc) {
      return err('ssh: not available in this environment (needs the standalone app)');
    }

    const execToken = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const onAbort = (): void => {
      void rpc.call('tray-exec-signal', { execToken }).catch(() => {});
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const timeoutMs = parsed.timeoutSec ? parsed.timeoutSec * 1000 : undefined;
      const result = await rpc.call(
        'tray-exec',
        {
          runtimeId: parsed.runtimeId,
          command: parsed.command,
          cwd: parsed.cwd,
          execToken,
          timeoutMs,
          stdin: encodeStdin(ctx),
        },
        { timeoutMs: (timeoutMs ?? SSH_MAX_MS) + 5000 }
      );
      if (result.error) {
        return {
          stdout: result.stdout,
          stderr: `${result.stderr}ssh: ${result.error}\n`,
          exitCode: result.exitCode || 1,
        };
      }
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error) {
      return err(`ssh: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  });
}
