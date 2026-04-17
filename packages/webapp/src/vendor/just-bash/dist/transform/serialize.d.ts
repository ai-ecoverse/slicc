import type { ScriptNode, WordNode } from "../ast/types.js";
export declare function serialize(node: ScriptNode): string;
export { serializeWord };
declare function serializeWord(node: WordNode): string;
