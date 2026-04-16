/**
 * Central aggregator for command fuzz flag metadata.
 * Imports flagsForFuzzing from every command file and provides a lookup Map.
 */
import type { CommandFuzzInfo } from "./fuzz-flags-types.js";
/** Get all command fuzz info entries */
export declare function getAllCommandFuzzInfo(): CommandFuzzInfo[];
export type { CommandFuzzInfo };
