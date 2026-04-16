/**
 * OverlayFs - Copy-on-write filesystem backed by a real directory
 *
 * Reads come from the real filesystem, writes go to an in-memory layer.
 * Changes don't persist to disk and can't escape the root directory.
 *
 * Security: Symlinks are blocked by default (allowSymlinks: false).
 * All real-FS access goes through resolveRealPath_() / resolveRealPathParent_()
 * gates which detect symlink traversal via path comparison and return the
 * canonical path for I/O (closing the TOCTOU gap). New methods must use these
 * gates — never access the real FS directly.
 */
import { type FileContent } from "../encoding.js";
import type { CpOptions, DirentEntry, FsStat, IFileSystem, MkdirOptions, ReadFileOptions, RmOptions, WriteFileOptions } from "../interface.js";
export interface OverlayFsOptions {
    /**
     * The root directory on the real filesystem.
     * All paths are relative to this root and cannot escape it.
     */
    root: string;
    /**
     * The virtual mount point where the root directory appears.
     * Defaults to "/home/user/project".
     */
    mountPoint?: string;
    /**
     * If true, all write operations will throw an error.
     * Useful for truly read-only access to the filesystem.
     * Defaults to false.
     */
    readOnly?: boolean;
    /**
     * Maximum file size in bytes that can be read from the real filesystem.
     * Files larger than this will throw an EFBIG error.
     * Defaults to 10MB (10485760).
     */
    maxFileReadSize?: number;
    /**
     * Whether to allow following and creating symlinks on the real filesystem.
     * When false (default), any real-FS path traversing a symlink is rejected
     * and symlink() throws EPERM.
     */
    allowSymlinks?: boolean;
}
export declare class OverlayFs implements IFileSystem {
    private readonly root;
    private readonly canonicalRoot;
    private readonly mountPoint;
    private readonly readOnly;
    private readonly maxFileReadSize;
    private readonly allowSymlinks;
    private readonly memory;
    private readonly deleted;
    constructor(options: OverlayFsOptions);
    /**
     * Throws an error if the filesystem is in read-only mode.
     */
    private assertWritable;
    /**
     * Create directory entries for the mount point path
     */
    private createMountPointDirs;
    /**
     * Get the mount point for this overlay
     */
    getMountPoint(): string;
    /**
     * Create a virtual directory in memory (sync, for initialization)
     */
    mkdirSync(path: string, _options?: MkdirOptions): void;
    /**
     * Create a virtual file in memory (sync, for initialization)
     */
    writeFileSync(path: string, content: string | Uint8Array): void;
    private getDirname;
    /**
     * Check if a normalized virtual path is under the mount point.
     * Returns the relative path within the mount point, or null if not under it.
     */
    private getRelativeToMount;
    /**
     * Convert a virtual path to a real filesystem path.
     * Returns null if the path is not under the mount point or would escape the root.
     */
    private toRealPath;
    /**
     * Resolve a real-FS path to its canonical form and validate it stays
     * within the sandbox.  Returns the canonical path for I/O, or null if
     * the path escapes the root or traverses a symlink (when !allowSymlinks).
     *
     * Callers MUST use the returned canonical path for subsequent I/O to
     * close the TOCTOU gap between validation and use.
     */
    private resolveRealPath_;
    /**
     * Resolve only the parent directory of a real-FS path, then join with
     * the original basename.  Used by lstat/readlink/existsInOverlay where
     * the final component may itself be a symlink we want to inspect (not
     * follow).  Returns the canonical parent + basename for I/O, or null.
     */
    private resolveRealPathParent_;
    private sanitizeError;
    private ensureParentDirs;
    /**
     * Check if a path exists in the overlay (memory + real fs - deleted)
     */
    private existsInOverlay;
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    readFileBuffer(path: string, seen?: Set<string>): Promise<Uint8Array>;
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string, seen?: Set<string>): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    private resolveSymlink;
    /**
     * Convert a real-fs symlink target to a virtual target suitable for resolveSymlink.
     * Handles absolute real-fs paths that point within the root by converting them
     * to virtual paths relative to the mount point.
     */
    private realTargetToVirtual;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    /**
     * Core readdir implementation that returns entries with file types.
     * Both readdir and readdirWithFileTypes use this shared implementation.
     */
    private readdirCore;
    /**
     * Follow symlinks to resolve the final directory path.
     * Returns outsideOverlay: true if the symlink points outside the overlay or
     * the resolved target doesn't exist (security - broken symlinks return []).
     */
    private resolveForReaddir;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    rm(path: string, options?: RmOptions): Promise<void>;
    /**
     * Check (synchronously) whether a path exists on the real filesystem.
     * Used to decide whether a tombstone is needed after deletion.
     */
    private existsOnRealFs;
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    resolvePath(base: string, rel: string): string;
    getAllPaths(): string[];
    private scanRealFs;
    chmod(path: string, mode: number): Promise<void>;
    symlink(target: string, linkPath: string): Promise<void>;
    link(existingPath: string, newPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    /**
     * Resolve all symlinks in a path to get the canonical physical path.
     * This is equivalent to POSIX realpath().
     */
    realpath(path: string): Promise<string>;
    /**
     * Set access and modification times of a file
     * @param path - The file path
     * @param _atime - Access time (ignored, kept for API compatibility)
     * @param mtime - Modification time
     */
    utimes(path: string, _atime: Date, mtime: Date): Promise<void>;
}
