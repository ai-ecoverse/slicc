/**
 * gzip - compress or expand files
 *
 * Also provides gunzip (decompress) and zcat (decompress to stdout) commands.
 */
import type { Command } from "../../types.js";
export declare const gzipCommand: Command;
export declare const gunzipCommand: Command;
export declare const zcatCommand: Command;
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";
export declare const flagsForFuzzing: CommandFuzzInfo;
export declare const gunzipFlagsForFuzzing: CommandFuzzInfo;
export declare const zcatFlagsForFuzzing: CommandFuzzInfo;
