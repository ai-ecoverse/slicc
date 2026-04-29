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
      // Drop the service worker first — it keeps its own IDB
      // connections open and will block deleteDatabase otherwise.
      // Then await every delete BEFORE reloading: a half-finished
      // delete that completes during the new page's `open()` aborts
      // the upgrade with "Version change transaction was aborted in
      // upgradeneeded event handler", leaving the user stranded on a
      // "Failed to start" screen.
      void (async () => {
        try {
          const regs = await navigator.serviceWorker?.getRegistrations?.();
          if (regs) await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
        } catch {
          /* ignore — best effort */
        }
        try {
          // Drop the welcome-flow dedup ledger so the welcome dip
          // and its follow-up licks fire fresh on the next boot.
          // (Other localStorage entries — provider keys, layout prefs
          // — survive nuke by design.)
          localStorage.removeItem('slicc:welcome-flow-fired');
        } catch {
          /* localStorage disabled — ignore */
        }
        try {
          const dbs = await indexedDB.databases();
          await Promise.all(
            dbs
              .filter((db): db is { name: string; version?: number } => !!db.name)
              .map(
                (db) =>
                  new Promise<void>((resolve) => {
                    const req = indexedDB.deleteDatabase(db.name);
                    // `onblocked` fires when another tab is holding a
                    // connection — resolve anyway so we don't hang the
                    // reload forever; the worst case is a single DB
                    // surviving, which the user can fix with a
                    // second nuke.
                    req.onsuccess = () => resolve();
                    req.onerror = () => resolve();
                    req.onblocked = () => resolve();
                  })
              )
          );
        } catch {
          /* indexedDB.databases unsupported on some browsers — fall through */
        }
        try {
          // Bypass the bf-cache so the new page boots from a clean slate.
          location.reload();
        } catch {
          /* ignore */
        }
      })();
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
