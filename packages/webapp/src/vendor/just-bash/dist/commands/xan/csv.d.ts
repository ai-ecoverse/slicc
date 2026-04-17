/**
 * CSV parsing and formatting utilities for xan command
 */
import type { CommandContext, ExecResult } from "../../types.js";
export interface CsvRow {
    [key: string]: string | number | boolean | null;
}
export type CsvData = CsvRow[];
/**
 * Create a null-prototype CsvRow to prevent prototype pollution.
 * User-controlled CSV column names could match dangerous keys like
 * __proto__, constructor, or prototype. Using a null-prototype object
 * ensures these don't access the prototype chain.
 */
export declare function createSafeRow(): CsvRow;
/**
 * Set a property on a CsvRow.
 * Since CsvRow uses null-prototype, this is safe from prototype pollution.
 */
export declare function safeSetRow(row: CsvRow, key: string, value: string | number | boolean | null): void;
/**
 * Convert a plain object row to a safe null-prototype row.
 */
export declare function toSafeRow(plainRow: Record<string, unknown>): CsvRow;
/** Parse CSV input string to array of row objects */
export declare function parseCsv(input: string): {
    headers: string[];
    data: CsvData;
};
/** Format array of row objects back to CSV string */
export declare function formatCsv(headers: string[], data: CsvData): string;
/** Read CSV input from file or stdin */
export declare function readCsvInput(args: string[], ctx: CommandContext): Promise<{
    headers: string[];
    data: CsvData;
    error?: ExecResult;
}>;
