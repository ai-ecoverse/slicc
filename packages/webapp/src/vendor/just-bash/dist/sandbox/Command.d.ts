import type { Bash } from "../Bash.js";
export interface OutputMessage {
    type: "stdout" | "stderr";
    data: string;
    timestamp: Date;
}
export declare class Command {
    readonly cmdId: string;
    readonly cwd: string;
    readonly startedAt: Date;
    exitCode: number | undefined;
    private bashEnv;
    private cmdLine;
    private env?;
    private explicitCwd;
    private signal?;
    private timeoutMs?;
    private abortController;
    private timeoutId;
    private externalAbortListener;
    private resultPromise;
    constructor(bashEnv: Bash, cmdLine: string, cwd: string, env?: Record<string, string>, explicitCwd?: boolean, signal?: AbortSignal, timeoutMs?: number);
    private setupCancellation;
    private cleanupCancellation;
    private execute;
    logs(): AsyncGenerator<OutputMessage, void, unknown>;
    wait(): Promise<CommandFinished>;
    output(): Promise<string>;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
    kill(): Promise<void>;
}
export interface CommandFinished extends Command {
    exitCode: number;
}
