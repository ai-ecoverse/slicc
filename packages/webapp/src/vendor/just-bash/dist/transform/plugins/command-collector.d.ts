import type { TransformContext, TransformPlugin, TransformResult } from "../types.js";
export interface CommandCollectorMetadata {
    commands: string[];
}
export declare class CommandCollectorPlugin implements TransformPlugin<CommandCollectorMetadata> {
    readonly name = "command-collector";
    transform(context: TransformContext): TransformResult<CommandCollectorMetadata>;
    private walkScript;
    private walkStatement;
    private walkPipeline;
    private walkCommand;
    private walkWordParts;
    private walkParameterOp;
    private extractName;
}
