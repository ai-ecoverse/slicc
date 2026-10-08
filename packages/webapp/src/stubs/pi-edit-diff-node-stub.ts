/**
 * Browser-safe stub for the Node imports of
 * @earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js
 * (`fs`, `fs/promises` and `./path-utils.js`).
 *
 * edit-diff.js only touches them in its preview helper, which reads files
 * from disk. SLICC calls the pure matching functions and does the file I/O
 * against the VFS (`tools/pi-edit-execution.ts`), so these never run.
 *
 * See: packages/webapp/vite.config.ts (stub-pi-node-internals plugin)
 */

export const constants = { R_OK: 4 };

export function access(): never {
  throw new Error('fs.access is not available in the browser');
}

export function readFile(): never {
  throw new Error('fs.readFile is not available in the browser');
}

export function resolveToCwd(): never {
  throw new Error('resolveToCwd is not available in the browser');
}
