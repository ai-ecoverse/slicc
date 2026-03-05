/**
 * Git integration for the virtual filesystem using isomorphic-git.
 *
 * Provides git commands that work with VirtualFS, enabling version control
 * in the browser-based environment.
 */

export { GitFs } from './git-fs.js';
export { GitCommands, createGitCommands } from './git-commands.js';
