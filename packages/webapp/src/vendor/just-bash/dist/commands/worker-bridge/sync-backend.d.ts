/**
 * Worker-side synchronous backend
 *
 * Runs in the worker thread and makes synchronous calls to the main thread
 * via SharedArrayBuffer + Atomics.
 */
/**
 * Synchronous backend for worker threads.
 */
export declare class SyncBackend {
    private protocol;
    private operationTimeoutMs;
    constructor(sharedBuffer: SharedArrayBuffer, operationTimeoutMs?: number);
    private execSync;
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array): void;
    stat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        mode: number;
        size: number;
        mtime: Date;
    };
    lstat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        mode: number;
        size: number;
        mtime: Date;
    };
    readdir(path: string): string[];
    mkdir(path: string, recursive?: boolean): void;
    rm(path: string, recursive?: boolean, force?: boolean): void;
    exists(path: string): boolean;
    appendFile(path: string, data: Uint8Array): void;
    symlink(target: string, linkPath: string): void;
    readlink(path: string): string;
    chmod(path: string, mode: number): void;
    realpath(path: string): string;
    rename(oldPath: string, newPath: string): void;
    copyFile(src: string, dest: string): void;
    writeStdout(data: string): void;
    writeStderr(data: string): void;
    exit(code: number): void;
    /**
     * Make an HTTP request through the main thread's secureFetch.
     * Returns the response as a parsed object.
     */
    httpRequest(url: string, options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    }): {
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
        bodyBase64: string;
        url: string;
    };
    /**
     * Execute a shell command through the main thread's exec function.
     * Returns the result as { stdout, stderr, exitCode }.
     */
    execCommand(command: string, stdin?: string): {
        stdout: string;
        stderr: string;
        exitCode: number;
    };
    /**
     * Execute a shell command with structured args (shell-escaped on the main thread).
     * Prevents command injection from unsanitized args.
     */
    execCommandArgs(command: string, args: string[]): {
        stdout: string;
        stderr: string;
        exitCode: number;
    };
}
