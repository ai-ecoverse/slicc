/**
 * AWK Runtime Context
 *
 * Holds all state for AWK program execution.
 */
import { type RegexLike } from "../../../regex/index.js";
import type { FeatureCoverageWriter } from "../../../types.js";
import type { AwkFunctionDef } from "../ast.js";
import type { AwkFileSystem, AwkValue } from "./types.js";
export interface AwkRuntimeContext {
    FS: string;
    OFS: string;
    ORS: string;
    OFMT: string;
    NR: number;
    NF: number;
    FNR: number;
    FILENAME: string;
    RSTART: number;
    RLENGTH: number;
    SUBSEP: string;
    fields: string[];
    line: string;
    vars: Record<string, AwkValue>;
    arrays: Record<string, Record<string, AwkValue>>;
    arrayAliases: Map<string, string>;
    ARGC: number;
    ARGV: Record<string, string>;
    ENVIRON: Record<string, string>;
    functions: Map<string, AwkFunctionDef>;
    lines?: string[];
    lineIndex?: number;
    fieldSep: RegexLike;
    maxIterations: number;
    maxRecursionDepth: number;
    maxOutputSize: number;
    currentRecursionDepth: number;
    exitCode: number;
    shouldExit: boolean;
    shouldNext: boolean;
    shouldNextFile: boolean;
    loopBreak: boolean;
    loopContinue: boolean;
    returnValue?: AwkValue;
    hasReturn: boolean;
    inEndBlock: boolean;
    output: string;
    fs?: AwkFileSystem;
    cwd?: string;
    openedFiles: Set<string>;
    random?: () => number;
    exec?: (cmd: string) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    coverage?: FeatureCoverageWriter;
    requireDefenseContext?: boolean;
}
export interface CreateContextOptions {
    fieldSep?: RegexLike;
    maxIterations?: number;
    maxRecursionDepth?: number;
    maxOutputSize?: number;
    fs?: AwkFileSystem;
    cwd?: string;
    exec?: (cmd: string) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    coverage?: FeatureCoverageWriter;
    requireDefenseContext?: boolean;
}
export declare function createRuntimeContext(options?: CreateContextOptions): AwkRuntimeContext;
