import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsText } from '../just-bash-compat.js';
import { parseWebsocatArgs, websocatHelp } from './websocat-args.js';
import { runWebsocatSession } from './websocat-session.js';

export interface WebsocatRunDeps {
  WebSocketCtor?: typeof WebSocket;
}

function validationError(stderr: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: '', stderr, exitCode: 2 };
}

function resolveWebSocketCtor(deps: WebsocatRunDeps): typeof WebSocket | undefined {
  return deps.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
}

export async function runWebsocat(
  args: string[],
  ctx: { stdin: string },
  deps: WebsocatRunDeps = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const parsed = parseWebsocatArgs(args);
  if (parsed.showHelp) return websocatHelp();
  if (parsed.error) return validationError(parsed.error);
  if (!parsed.url) {
    return validationError('websocat: missing ws:// or wss:// URL (use --help for usage)\n');
  }
  if (!/^wss?:\/\//i.test(parsed.url)) {
    return validationError(`websocat: URL must start with ws:// or wss://, got '${parsed.url}'\n`);
  }

  const WS = resolveWebSocketCtor(deps);
  if (!WS) {
    return {
      stdout: '',
      stderr: 'websocat: no WebSocket implementation available in this runtime\n',
      exitCode: 1,
    };
  }

  return runWebsocatSession(parsed, ctx.stdin, WS);
}

export function createWebsocatCommand(): Command {
  return defineCommand('websocat', async (args, ctx) => {
    return runWebsocat(args, { stdin: stdinAsText(ctx.stdin) });
  });
}
