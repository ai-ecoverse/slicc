import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

export function createNukeCommand(): Command {
  return defineCommand('nuke', async (args) => {
    // Check for the secret launch code: exactly args ['1', '2', '3', '4']
    if (
      args.length === 4 &&
      args[0] === '1' &&
      args[1] === '2' &&
      args[2] === '3' &&
      args[3] === '4'
    ) {
      // Delete all IndexedDB databases and reload
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((db) =>
          db.name
            ? new Promise<void>((res) => {
                const req = indexedDB.deleteDatabase(db.name!);
                req.onsuccess = () => res();
                req.onerror = () => res();
                req.onblocked = () => res();
              })
            : Promise.resolve()
        )
      );
      location.reload();
      return { stdout: 'Nuking everything…\n', stderr: '', exitCode: 0 };
    }

    // No valid launch code — show warning
    return {
      stdout: '',
      stderr:
        '⚠️  WARNING: this will reset the entire environment, file system, chats, and scoops.\n' +
        'Run `nuke 1 2 3 4` to proceed.\n',
      exitCode: 1,
    };
  });
}
