import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';

/**
 * Options accepted by {@link createAgentCommand}.
 * The command body loads on the first call so the parser stays out of the
 * kernel worker's eager import graph.
 */
export interface AgentCommandOptions {
  /**
   * Returns the JID of the scoop (or cone) that owns the shell invoking
   * `agent`. Forwarded to the bridge as `parentJid` so the spawned scoop
   * inherits the parent's `config.modelId` (or falls back to the global UI
   * selection when the parent has none). Returns `undefined` when the shell
   * is not attached to a scoop context — e.g., the terminal panel's own
   * standalone `AlmostBashShell`.
   */
  getParentJid?: () => string | undefined;
}

export function createAgentCommand(options: AgentCommandOptions = {}): Command {
  return defineCommand('agent', async (args: string[], ctx: CommandContext) => {
    const { executeAgentCommand } = await import('./agent-command-impl.js');
    return executeAgentCommand(args, ctx, options);
  });
}
