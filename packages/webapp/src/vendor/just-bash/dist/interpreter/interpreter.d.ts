/**
 * Interpreter - AST Execution Engine
 *
 * Main interpreter class that executes bash AST nodes.
 * Delegates to specialized modules for:
 * - Word expansion (expansion.ts)
 * - Arithmetic evaluation (arithmetic.ts)
 * - Conditional evaluation (conditionals.ts)
 * - Built-in commands (builtins.ts)
 * - Redirections (redirections.ts)
 */
import type { ScriptNode } from "../ast/types.js";
import type { IFileSystem } from "../fs/interface.js";
import type { ExecutionLimits } from "../limits.js";
import type { SecureFetch } from "../network/index.js";
import type { CommandRegistry, ExecResult, FeatureCoverageWriter, TraceCallback } from "../types.js";
import type { InterpreterState } from "./types.js";
export type { InterpreterContext, InterpreterState } from "./types.js";
export interface InterpreterOptions {
    fs: IFileSystem;
    commands: CommandRegistry;
    limits: Required<ExecutionLimits>;
    exec: (script: string, options?: {
        env?: Record<string, string>;
        cwd?: string;
        replaceEnv?: boolean;
        signal?: AbortSignal;
        args?: string[];
    }) => Promise<ExecResult>;
    /** Optional secure fetch function for network-enabled commands */
    fetch?: SecureFetch;
    /** Optional sleep function for testing with mock clocks */
    sleep?: (ms: number) => Promise<void>;
    /** Optional trace callback for performance profiling */
    trace?: TraceCallback;
    /** Optional feature coverage writer for fuzzing instrumentation */
    coverage?: FeatureCoverageWriter;
    /**
     * When true, fail closed if execution occurs outside defense async context.
     */
    requireDefenseContext?: boolean;
    /** Bootstrap JavaScript code for js-exec */
    jsBootstrapCode?: string;
}
export declare class Interpreter {
    private ctx;
    constructor(options: InterpreterOptions, state: InterpreterState);
    /**
     * Fail closed if defense is expected but async context is missing.
     */
    private assertDefenseContext;
    /**
     * Build environment record containing only exported variables.
     * In bash, only exported variables are passed to child processes.
     * This includes both permanently exported variables (via export/declare -x)
     * and temporarily exported variables (prefix assignments like FOO=bar cmd).
     */
    private buildExportedEnv;
    executeScript(node: ScriptNode): Promise<ExecResult>;
    /**
     * Execute a user script file found in PATH.
     */
    private executeUserScript;
    private executeStatement;
    private executePipeline;
    private executeCommand;
    private executeSimpleCommand;
    private executeSimpleCommandInner;
    private runCommand;
    private aliasExpansionStack;
    private expandAlias;
    findCommandInPath(commandName: string): Promise<string[]>;
    private executeSubshell;
    private executeGroup;
    private executeArithmeticCommand;
    private executeConditionalCommand;
}
