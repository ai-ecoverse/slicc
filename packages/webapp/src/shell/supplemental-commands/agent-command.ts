import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';

export interface AgentCommandOptions {
  getParentJid?: () => string | undefined;
}

export function createAgentCommand(options: AgentCommandOptions = {}): Command {
  return defineCommand('agent', async (args: string[], ctx: CommandContext) => {
    const { executeAgentCommand } = await import('./agent-command-impl.js');
    return executeAgentCommand(args, ctx, options);
  });
}
