/**
 * Git integration for the virtual filesystem using isomorphic-git.
 *
 * Provides git commands that work with VirtualFS, enabling version control
 * in the browser-based environment.
 */

export { GitCommands, createGitCommands } from './git-commands.js';
export type { GitCommandResult, GitCommandsOptions } from './git-commands.js';
