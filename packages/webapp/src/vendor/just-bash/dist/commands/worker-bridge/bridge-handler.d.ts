/**
 * Main thread bridge handler
 *
 * Runs on the main thread and processes filesystem, I/O, HTTP, and exec
 * requests from a worker thread via SharedArrayBuffer + Atomics.
 */
import type { IFileSystem } from "../../fs/interface.js";
import type { SecureFetch } from "../../network/fetch.js";
import type { CommandExecOptions, ExecResult } from "../../types.js";
export interface BridgeOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Handles requests from a worker thread.
 */
export declare class BridgeHandler {
    private fs;
    private cwd;
    private commandName;
    private secureFetch;
    private maxOutputSize;
    private exec;
    private protocol;
    private running;
    private output;
    private outputLimitExceeded;
    private startTime;
    private timeoutMs;
    constructor(sharedBuffer: SharedArrayBuffer, fs: IFileSystem, cwd: string, commandName: string, secureFetch?: SecureFetch | undefined, maxOutputSize?: number, exec?: ((command: string, options: CommandExecOptions) => Promise<ExecResult>) | undefined);
    /**
     * Returns remaining milliseconds before the overall execution deadline.
     */
    private remainingMs;
    /**
     * Races a promise against the remaining execution deadline.
     * If the deadline expires first, sets `this.running = false` and rejects.
     */
    private raceDeadline;
    /**
     * Run the handler loop until EXIT operation or timeout.
     */
    run(timeoutMs: number): Promise<BridgeOutput>;
    stop(): void;
    private handleOperation;
    private resolvePath;
    private handleReadFile;
    private handleWriteFile;
    private handleStat;
    private handleLstat;
    private handleReaddir;
    private handleMkdir;
    private handleRm;
    private handleExists;
    private handleAppendFile;
    private handleSymlink;
    private handleReadlink;
    private handleChmod;
    private handleRealpath;
    private handleRename;
    private handleCopyFile;
    private handleWriteStdout;
    private handleWriteStderr;
    private handleExit;
    private tryAppendOutput;
    private appendOutputLimitError;
    private handleHttpRequest;
    private handleExecCommand;
    private setErrorFromException;
}
