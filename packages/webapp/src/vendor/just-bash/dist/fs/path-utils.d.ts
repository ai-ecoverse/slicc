/**
 * Pure path utilities for virtual filesystems.
 *
 * No node:fs or node:path dependencies — safe for browser bundles.
 * Real-FS-backed implementations should import from real-fs-utils.ts
 * (which re-exports these) to keep a single import source.
 */
/** Maximum depth for symlink resolution loops. */
export declare const MAX_SYMLINK_DEPTH = 40;
/** Default directory permissions. */
export declare const DEFAULT_DIR_MODE = 493;
/** Default file permissions. */
export declare const DEFAULT_FILE_MODE = 420;
/** Default symlink permissions. */
export declare const SYMLINK_MODE = 511;
/**
 * Normalize a virtual path: resolve `.` and `..`, ensure it starts with `/`,
 * strip trailing slashes.  Pure function, no I/O.
 */
export declare function normalizePath(path: string): string;
/**
 * Validate that a path does not contain null bytes.
 * Null bytes in paths can be used to truncate filenames or bypass security
 * filters.
 */
export declare function validatePath(path: string, operation: string): void;
/**
 * Get the directory name of a normalized virtual path.
 */
export declare function dirname(path: string): string;
/**
 * Resolve a relative path against a base directory.
 * If `path` is absolute, it is normalized and returned directly.
 */
export declare function resolvePath(base: string, path: string): string;
/**
 * Join a parent path with a child name.
 * Handles the root-path edge case (`"/" + "child"` → `"/child"`).
 */
export declare function joinPath(parent: string, child: string): string;
/**
 * Resolve a symlink target relative to the symlink's location.
 * Absolute targets are normalized directly; relative targets are
 * resolved from the symlink's parent directory.
 */
export declare function resolveSymlinkTarget(symlinkPath: string, target: string): string;
