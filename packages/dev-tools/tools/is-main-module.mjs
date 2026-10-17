import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `metaUrl` is the script node was started with.
 *
 * Compares real paths on both sides. Node resolves symlinks for
 * `import.meta.url` but not for `process.argv[1]`, so the usual
 * `import.meta.url === pathToFileURL(argv[1]).href` check is false when the
 * script runs through a symlinked checkout or a `node_modules/.bin` link. The
 * script then exits 0 without doing anything, and a gate built on it passes
 * silently.
 *
 * @param {string} metaUrl the caller's `import.meta.url`
 * @param {string | undefined} [argv1] defaults to `process.argv[1]`
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
