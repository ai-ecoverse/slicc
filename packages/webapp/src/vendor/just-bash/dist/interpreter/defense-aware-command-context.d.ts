import type { CommandContext } from "../types.js";
/**
 * Wrap command context APIs so async boundaries are fail-closed if defense
 * context is expected but missing.
 */
export declare function createDefenseAwareCommandContext(ctx: CommandContext, commandName: string): CommandContext;
