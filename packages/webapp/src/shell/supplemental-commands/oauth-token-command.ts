import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createOAuthTokenCommand(): Command {
  return defineCommand('oauth-token', async (args, ctx) => {
    const { runOAuthToken } = await import('./oauth-token/run.js');
    return runOAuthToken(args, ctx);
  });
}
