import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

export function createNukeCommand(): Command {
  return defineCommand('nuke', async (args) => {
    // Help flag
    if (args.includes('--help') || args.includes('-h')) {
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
      let hadBlocked = false;
      let hadError = false;
      await Promise.all(
        dbs.map((db) =>
          db.name
            ? new Promise<void>((res) => {
                const req = indexedDB.deleteDatabase(db.name!);
                req.onsuccess = () => res();
                req.onerror = () => {
                  hadError = true;
                  res();
                };
                req.onblocked = () => {
                  hadBlocked = true;
                  res();
                };
              })
            : Promise.resolve()
        )
      );

      if (hadBlocked) {
        return {
          stdout: '',
          stderr:
            'Some databases could not be deleted because they are still in use ' +
            '(another tab or window may be open).\n' +
            'Close other tabs and try again.\n',
          exitCode: 1,
        };
      }
      if (hadError) {
        return {
          stdout: '',
          stderr:
            'Some databases could not be deleted due to an unexpected error.\n' +
            'Close other tabs and try again.\n',
          exitCode: 1,
        };
      }

      setTimeout(() => location.reload(), 0);
      return { stdout: 'Nuking everything…\n', stderr: '', exitCode: 0 };
    }

    // No valid launch code — show warning
    return {
      stdout: '',
      stderr:
        '⚠️  WARNING: this will reset the entire environment, file system, chats, and scoops.\n' +
        'Run nuke again with the secret launch code to proceed.\n',
      exitCode: 1,
    };
  });
}
