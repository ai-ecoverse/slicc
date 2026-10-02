export type RequestedToolSurface = 'auto' | 'full' | 'output';

export type EffectiveToolSurface = 'full' | 'output' | 'none';

const NO_OP_COMMANDS = new Set(['true', 'false', ':']);

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
