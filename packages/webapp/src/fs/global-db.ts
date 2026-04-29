/**
 * IndexedDB name of the global VirtualFS used to persist cross-cwd state
 * (GitHub auth token, global gitconfig, etc.). Must be referenced by every
 * writer and reader of these files — using the wrong DB silently writes to
 * the wrong place. The git provider, the upskill command, and `GitCommands`
 * all import this so the wiring stays in sync.
 */
export const GLOBAL_FS_DB_NAME = 'slicc-fs-global';
