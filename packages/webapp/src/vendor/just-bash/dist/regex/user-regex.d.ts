/**
 * UserRegex - Centralized regex handling for user-provided patterns
 *
 * This module provides a single point of control for all user-provided regex
 * execution. Uses RE2JS for ReDoS protection via linear-time matching.
 *
 * All user-provided regex patterns should go through this module.
 * Internal patterns (those we control) can use ConstantRegex for the same interface.
 */
/**
 * Type for replacement callback functions.
 * Matches the signature of String.prototype.replace callback.
 */
export type ReplaceCallback = (match: string, ...args: (string | number | Record<string, string>)[]) => string;
/**
 * Common interface for regex wrappers.
 * Both UserRegex (for user patterns) and ConstantRegex (for internal patterns) implement this.
 */
export interface RegexLike {
    test(input: string): boolean;
    exec(input: string): RegExpExecArray | null;
    match(input: string): RegExpMatchArray | null;
    replace(input: string, replacement: string | ReplaceCallback): string;
    split(input: string, limit?: number): string[];
    search(input: string): number;
    matchAll(input: string): IterableIterator<RegExpMatchArray>;
    readonly native: RegExp;
    readonly source: string;
    readonly flags: string;
    readonly global: boolean;
    readonly ignoreCase: boolean;
    readonly multiline: boolean;
    lastIndex: number;
}
/**
 * A wrapper around RE2JS that provides a RegExp-compatible interface.
 * Uses RE2 for linear-time matching, providing ReDoS protection.
 */
export declare class UserRegex implements RegexLike {
    private readonly _re2;
    private readonly _pattern;
    private readonly _flags;
    private readonly _global;
    private readonly _ignoreCase;
    private readonly _multiline;
    private _lastIndex;
    private _nativeRegex;
    constructor(pattern: string, flags?: string);
    /**
     * Test if the pattern matches the input string.
     */
    test(input: string): boolean;
    /**
     * Execute the pattern against the input string.
     * Returns match array with capture groups, or null if no match.
     */
    exec(input: string): RegExpExecArray | null;
    /**
     * Match the input string against the pattern.
     * With global flag, returns all matches. Without, returns first match with groups.
     */
    match(input: string): RegExpMatchArray | null;
    /**
     * Replace matches in the input string.
     * @param input - The string to search in
     * @param replacement - A string or callback function
     */
    replace(input: string, replacement: string | ReplaceCallback): string;
    /**
     * Split the input string by the pattern.
     * Note: RE2JS split with limit includes remainder in last element (Java-style),
     * but JS split truncates to exactly limit elements. We implement JS behavior.
     */
    split(input: string, limit?: number): string[];
    /**
     * Search for the pattern in the input string.
     * Returns the index of the first match, or -1 if not found.
     */
    search(input: string): number;
    /**
     * Get all matches using an iterator (for global regexes).
     */
    matchAll(input: string): IterableIterator<RegExpMatchArray>;
    /**
     * Get the underlying RegExp object.
     * Creates a native RegExp lazily for compatibility with code that needs it.
     * Note: The native RegExp is only for compatibility - actual matching uses RE2.
     */
    get native(): RegExp;
    /**
     * Get the pattern string.
     */
    get source(): string;
    /**
     * Get the flags string.
     */
    get flags(): string;
    /**
     * Check if this is a global regex.
     */
    get global(): boolean;
    /**
     * Check if this is a case-insensitive regex.
     */
    get ignoreCase(): boolean;
    /**
     * Check if this is a multiline regex.
     */
    get multiline(): boolean;
    /**
     * Get/set lastIndex for global regexes.
     */
    get lastIndex(): number;
    set lastIndex(value: number);
}
/**
 * Create a UserRegex from a pattern string and flags.
 * This is the primary entry point for user-provided regex patterns.
 * Uses RE2 for ReDoS protection.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags (g, i, m, s, u)
 * @returns A UserRegex instance
 * @throws Error if the pattern is invalid
 */
export declare function createUserRegex(pattern: string, flags?: string): UserRegex;
/**
 * A wrapper around native RegExp for constant/internal patterns.
 * Use this for patterns we control (not user-provided) that don't need ReDoS protection.
 * Implements the same interface as UserRegex for consistency.
 */
export declare class ConstantRegex implements RegexLike {
    private readonly _regex;
    constructor(regex: RegExp);
    test(input: string): boolean;
    exec(input: string): RegExpExecArray | null;
    match(input: string): RegExpMatchArray | null;
    replace(input: string, replacement: string | ReplaceCallback): string;
    split(input: string, limit?: number): string[];
    search(input: string): number;
    matchAll(input: string): IterableIterator<RegExpMatchArray>;
    get native(): RegExp;
    get source(): string;
    get flags(): string;
    get global(): boolean;
    get ignoreCase(): boolean;
    get multiline(): boolean;
    get lastIndex(): number;
    set lastIndex(value: number);
}
