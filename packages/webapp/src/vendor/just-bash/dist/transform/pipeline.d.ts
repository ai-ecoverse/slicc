import type { BashTransformResult, TransformPlugin } from "./types.js";
export declare class BashTransformPipeline<TMetadata extends object = Record<string, never>> {
    private plugins;
    use<M extends object>(plugin: TransformPlugin<M>): BashTransformPipeline<TMetadata & M>;
    transform(script: string): BashTransformResult<TMetadata>;
}
