/**
 * ReadWriteFs - Direct wrapper around the real filesystem
 *
 * All operations go directly to the underlying Node.js filesystem.
 * Paths are relative to the configured root directory.
 *
 * Security: Symlinks are blocked by default (allowSymlinks: false).
 * All real-FS access goes through resolveAndValidate() / validateParent()
 * gates which detect symlink traversal via path comparison. When symlinks
 * are allowed, targets are validated and transformed to stay within root.
 * New methods must use these gates — never access the real FS directly.
 */
import { type FileContent } from "../encoding.js";
import type { CpOptions, DirentEntry, FsStat, IFileSystem, MkdirOptions, ReadFileOptions, RmOptions, WriteFileOptions } from "../interface.js";
export interface ReadWriteFsOptions {
    /**
     * The root directory on the real filesystem.
     * All paths are relative to this root.
     */
    root: string;
    /**
     * Maximum file size in bytes that can be read.
     * Files larger than this will throw an EFBIG error.
     * Defaults to 10MB (10485760).
     */
    maxFileReadSize?: number;
    /**
     * Whether to allow following and creating symlinks.
     * When false (default), any path traversing a symlink is rejected
     * and symlink() throws EPERM.
     */
    allowSymlinks?: boolean;
}
export declare class ReadWriteFs implements IFileSystem {
    private readonly root;
    private readonly canonicalRoot;
    private readonly maxFileReadSize;
    private readonly allowSymlinks;
    constructor(options: ReadWriteFsOptions);
    /**
     * Validate that a resolved real path stays within the sandbox root and
     * return the canonical (symlink-resolved) path for use in subsequent I/O.
     * This closes the TOCTOU gap where the original path could be swapped
     * between validation and use.
     * Throws EACCES if the path escapes the root.
     */
    private resolveAndValidate;
    /**
     * Validate the parent directory of a path (for operations like lstat/readlink
     * that should not follow the final component's symlink).
     * Returns the canonical parent joined with the original basename.
     */
    private validateParent;
    /**
     * Convert a virtual path to a real filesystem path.
     */
    private toRealPath;
    readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FsStat>;
    lstat(path: string): Promise<FsStat>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<DirentEntry[]>;
    rm(path: string, options?: RmOptions): Promise<void>;
    cp(src: string, dest: string, options?: CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    resolvePath(base: string, path: string): string;
    getAllPaths(): string[];
    private sanitizeError;
    /**
     * Recursively scan a directory for symlinks whose targets escape the sandbox.
     * Returns an array of paths (real OS paths) for any escaping symlinks found.
     */
    private findEscapingSymlinks;
    private scanDir;
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
     * @param atime - Access time
     * @param mtime - Modification time
     */
    utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}
