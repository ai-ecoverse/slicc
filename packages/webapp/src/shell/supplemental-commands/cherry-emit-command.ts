import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

/**
 * Leader-side registry the `cherry-emit` command drives. Bound to the same
 * object that calls `emitCherrySliccEvent` from Task 6 (the leader's cherry
 * runtime registry). `listRuntimeIds()` returns canonical ids
 * (`follower-<bootstrapId>`, see Task 8).
 */
export interface CherryRuntimeRegistry {
  listRuntimeIds(): string[];
  emitSliccEvent(runtimeId: string, name: string, detail: unknown): void;
}

export interface CherryEmitCommandOptions {
  /** Leader-side registry; absent in non-leader contexts (command still discoverable, reports no runtime). */
  registry?: CherryRuntimeRegistry;
}

export function createCherryEmitCommand(options: CherryEmitCommandOptions = {}): Command {
  const { registry } = options;
  return defineCommand('cherry-emit', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `cherry-emit - push a slicc.event to a cherry host page through a follower runtime

Usage: cherry-emit <name> [--detail <json>] [--runtime <id>]

  --detail <json>   JSON payload delivered as the event detail
  --runtime <id>    Target a specific follower runtime (canonical id, e.g. follower-abc).
                    Defaults to the sole connected runtime; required when more than one.
`,
        stderr: '',
        exitCode: 0,
      };
    }

    const positionals: string[] = [];
    let detailJson: string | undefined;
    let runtime: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--detail' || arg === '--runtime') {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('--')) {
          return { stdout: '', stderr: `cherry-emit: ${arg} requires a value\n`, exitCode: 1 };
        }
        if (arg === '--detail') detailJson = next;
        else runtime = next;
        i++;
      } else {
        positionals.push(arg!);
      }
    }

    const name = positionals[0];
    if (!name) {
      return { stdout: '', stderr: 'cherry-emit: event name is required\n', exitCode: 1 };
    }

    const ids = registry?.listRuntimeIds() ?? [];
    if (ids.length === 0) {
      return {
        stdout: '',
        stderr: 'cherry-emit: no cherry follower runtime is connected\n',
        exitCode: 1,
      };
    }
    if (!runtime) {
      if (ids.length > 1) {
        return {
          stdout: '',
          stderr: `cherry-emit: multiple runtimes connected, pass --runtime <id>. Available: ${ids.join(', ')}\n`,
          exitCode: 1,
        };
      }
      runtime = ids[0];
    } else if (!ids.includes(runtime)) {
      return {
        stdout: '',
        stderr: `cherry-emit: runtime '${runtime}' not connected. Available: ${ids.join(', ')}\n`,
        exitCode: 1,
      };
    }

    let detail: unknown;
    if (detailJson !== undefined) {
      try {
        detail = JSON.parse(detailJson);
      } catch {
        return { stdout: '', stderr: 'cherry-emit: --detail must be valid JSON\n', exitCode: 1 };
      }
    }

    registry!.emitSliccEvent(runtime!, name, detail);
    return { stdout: `cherry-emit: sent '${name}' to ${runtime}\n`, stderr: '', exitCode: 0 };
  });
}
