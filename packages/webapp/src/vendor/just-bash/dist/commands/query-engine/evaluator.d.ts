/**
 * Query expression evaluator
 *
 * Evaluates a parsed query AST against any value.
 * Used by jq, yq, and other query-based commands.
 */
import type { FeatureCoverageWriter } from "../../types.js";
import type { AstNode } from "./parser.js";
import { type QueryValue } from "./value-operations.js";
export type { QueryValue } from "./value-operations.js";
export interface QueryExecutionLimits {
    maxIterations?: number;
    maxDepth?: number;
}
export interface EvalContext {
    vars: Map<string, QueryValue>;
    limits: Required<Pick<QueryExecutionLimits, "maxIterations">> & QueryExecutionLimits;
    env?: Map<string, string>;
    requireDefenseContext?: boolean;
    defenseContextChecked?: boolean;
    /** Original document root for parent/root navigation */
    root?: QueryValue;
    /** Current path from root for parent navigation */
    currentPath?: (string | number)[];
    funcs?: Map<string, {
        params: string[];
        body: AstNode;
        closure?: Map<string, unknown>;
    }>;
    labels?: Set<string>;
    /** Feature coverage writer for fuzzing instrumentation */
    coverage?: FeatureCoverageWriter;
}
export interface EvaluateOptions {
    limits?: QueryExecutionLimits;
    env?: Map<string, string>;
    coverage?: FeatureCoverageWriter;
    requireDefenseContext?: boolean;
}
export declare function evaluate(value: QueryValue, ast: AstNode, ctxOrOptions?: EvalContext | EvaluateOptions): QueryValue[];
