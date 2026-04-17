import type { TransformContext, TransformPlugin, TransformResult } from "../types.js";
export interface TeePluginOptions {
    outputDir: string;
    targetCommandPattern?: {
        test(input: string): boolean;
    };
    timestamp?: Date;
}
export interface TeeFileInfo {
    commandIndex: number;
    commandName: string;
    /** The full command string (name + arguments) before tee wrapping */
    command: string;
    stdoutFile: string;
}
export interface TeePluginMetadata {
    teeFiles: TeeFileInfo[];
}
export declare class TeePlugin implements TransformPlugin<TeePluginMetadata> {
    readonly name = "tee";
    private options;
    private counter;
    constructor(options: TeePluginOptions);
    transform(context: TransformContext): TransformResult<TeePluginMetadata>;
    private formatTimestamp;
    private generateStdoutPath;
    private transformScript;
    private transformStatement;
    private transformPipeline;
    /**
     * Save PIPESTATUS entries for original commands into temp vars.
     * Produces: `__tps0=${PIPESTATUS[idx0]} __tps1=${PIPESTATUS[idx1]} ...`
     *
     * All expansions happen before any assignment (single simple command),
     * so all read from the same PIPESTATUS snapshot.
     */
    private makePipestatusSave;
    /**
     * Restore PIPESTATUS and exit code with a dummy pipeline.
     * Produces: `(exit $__tps0) | (exit $__tps1) | ...`
     *
     * This sets PIPESTATUS to the original commands' exit codes and
     * sets $? to the last original command's exit code.
     */
    private makePipestatusRestore;
    private shouldTarget;
    private getCommandName;
    private serializeCommand;
    private makeTeeCommand;
}
