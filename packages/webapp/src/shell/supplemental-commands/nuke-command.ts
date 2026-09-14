import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  NUKE_CONTROL_CHANNEL,
  NUKE_LOCAL_STORAGE_KEYS,
  type NukeReloadMsg,
} from './nuke-channel.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';
import { wipeLocalStorageState } from './wipe-local-storage-state.js';

export {
  installNukeReloadListener,
  NUKE_CONTROL_CHANNEL,
  NUKE_LOCAL_STORAGE_KEYS,
  type NukeReloadMsg,
} from './nuke-channel.js';

const NUKE_VALUE_FLAGS: readonly string[] = [];

const NUKE_BOOL_FLAGS = ['--yes'] as const;

export function createNukeCommand(): Command {
  return defineCommand('nuke', async (args) => {
    if (isHelpRequest(args, { valueFlags: NUKE_VALUE_FLAGS })) {
      return {
        stdout:
          'Usage: nuke <launch-code>\n\n' +
          'Completely reset the environment by deleting all local data and reloading.\n' +
          'Destroys the file system, chat history, and scoops database.\n' +
          'Requires the secret launch code to proceed.\n',
        stderr: '',
        exitCode: 0,
      };
    }

    const parsed = parseKnownFlags(args, { value: NUKE_VALUE_FLAGS, bool: NUKE_BOOL_FLAGS });
    if ('error' in parsed) {
      return { stdout: '', stderr: `nuke: ${parsed.error}\n`, exitCode: 1 };
    }

    if (parsed.positionals.join('').includes('1234')) {
      void (async () => {
        await wipeLocalStorageState();
        triggerReload(NUKE_LOCAL_STORAGE_KEYS);
      })();
      return { stdout: 'Nuking everything…\n', stderr: '', exitCode: 0 };
    }

    return {
      stdout: '',
      stderr:
        '⚠️  WARNING: this will reset the entire environment, file system, chats, and scoops.\n' +
        'Run nuke again with the secret launch code to proceed.\n',
      exitCode: 1,
    };
  });
}

function triggerReload(keysToRemove: readonly string[] = []): void {
  const keys = [...keysToRemove];
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
      channel.postMessage({ type: 'nuke-reload', keysToRemove: keys } satisfies NukeReloadMsg);

      setTimeout(() => channel.close(), 100);
    }
  } catch {}

  for (const key of keys) {
    try {
      (globalThis as { localStorage?: Storage }).localStorage?.removeItem(key);
    } catch {}
  }
  try {
    const loc = (globalThis as { location?: { reload?: () => void } }).location;
    loc?.reload?.();
  } catch {}
}
