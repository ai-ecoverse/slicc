/**
 * Which tools an `agent` spawn registers.
 *
 * `full` is every tool the unit's policy already gets. `auto` (the `agent`
 * command's default) drops tools a no-op allow-list cannot usefully call:
 * `true` / `false` / `:` plus a schema keeps only StructuredOutput. `output`
 * is StructuredOutput only when a schema is set; without one the surface is
 * empty (the command and the bridge reject that combination first).
 */

export type RequestedToolSurface = 'auto' | 'full' | 'output';

/** What {@link buildScoopTools} actually registers. */
export type EffectiveToolSurface = 'full' | 'output' | 'none';

const NO_OP_COMMANDS = new Set(['true', 'false', ':']);

/**
 * An allow-list that cannot run a useful command. Omitted or `*` is
 * unrestricted, not a no-op list.
 */
export function isNoOpAllowList(allowed: readonly string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return false;
  if (allowed.some((command) => command.trim() === '*')) return false;
  return allowed.every((command) => NO_OP_COMMANDS.has(command.trim()));
}

export function effectiveToolSurface(
  config:
    | {
        toolSurface?: RequestedToolSurface;
        allowedCommands?: readonly string[];
        structuredOutputSchema?: unknown;
      }
    | undefined
): EffectiveToolSurface {
  const requested = config?.toolSurface ?? 'full';
  if (requested === 'full') return 'full';
  if (requested === 'output') {
    return config?.structuredOutputSchema ? 'output' : 'none';
  }
  if (isNoOpAllowList(config?.allowedCommands)) {
    return config?.structuredOutputSchema ? 'output' : 'none';
  }
  return 'full';
}
