/**
 * rev - reverse lines characterwise
 *
 * Usage: rev [file ...]
 *
 * Copies the specified files to standard output, reversing the order
 * of characters in every line. If no files are specified, standard
 * input is read.
 */
import type { Command } from "../../types.js";
export declare const rev: Command;
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";
export declare const flagsForFuzzing: CommandFuzzInfo;
