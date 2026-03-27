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

    // Check for the secret launch code: args must contain '1234' when concatenated
    if (args.join('').includes('1234')) {
      // Fire deleteDatabase for every known DB — don't await.
      // The page holds open connections so onblocked will fire,
      // but the reload releases them and deletions complete.
      indexedDB.databases().then((dbs) => {
        for (const db of dbs) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
      });
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
