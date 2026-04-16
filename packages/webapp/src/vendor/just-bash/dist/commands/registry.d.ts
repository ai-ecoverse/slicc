import type { Command } from "../types.js";
/** All available built-in command names (excludes network commands) */
export type CommandName = "echo" | "cat" | "printf" | "ls" | "mkdir" | "rmdir" | "touch" | "rm" | "cp" | "mv" | "ln" | "chmod" | "pwd" | "readlink" | "head" | "tail" | "wc" | "stat" | "grep" | "fgrep" | "egrep" | "rg" | "sed" | "awk" | "sort" | "uniq" | "comm" | "cut" | "paste" | "tr" | "rev" | "nl" | "fold" | "expand" | "unexpand" | "strings" | "split" | "column" | "join" | "tee" | "find" | "basename" | "dirname" | "tree" | "du" | "env" | "printenv" | "alias" | "unalias" | "history" | "xargs" | "true" | "false" | "clear" | "bash" | "sh" | "jq" | "base64" | "diff" | "date" | "sleep" | "timeout" | "seq" | "expr" | "md5sum" | "sha1sum" | "sha256sum" | "file" | "html-to-markdown" | "help" | "which" | "tac" | "hostname" | "od" | "gzip" | "gunzip" | "zcat" | "tar" | "yq" | "xan" | "sqlite3" | "time" | "whoami";
/** Network command names (only available when network is configured) */
export type NetworkCommandName = "curl";
/** Python command names (only available when python is explicitly enabled) */
export type PythonCommandName = "python3" | "python";
/** JavaScript command names (only available when javascript is explicitly enabled) */
export type JavaScriptCommandName = "js-exec" | "node";
/** All command names including network, python, and javascript commands */
export type AllCommandName = CommandName | NetworkCommandName | PythonCommandName | JavaScriptCommandName;
/**
 * Gets all available command names (excludes network commands)
 */
export declare function getCommandNames(): string[];
/**
 * Gets all network command names
 */
export declare function getNetworkCommandNames(): string[];
/**
 * Creates all lazy commands for registration (excludes network commands)
 * @param filter Optional array of command names to include. If not provided, all commands are created.
 */
export declare function createLazyCommands(filter?: CommandName[]): Command[];
/**
 * Creates network commands for registration (curl, etc.)
 * These are only registered when network is explicitly configured.
 */
export declare function createNetworkCommands(): Command[];
/**
 * Gets all python command names
 */
export declare function getPythonCommandNames(): string[];
/**
 * Creates python commands for registration (python3, python).
 * These are only registered when python is explicitly enabled.
 * Note: Python introduces additional security surface (arbitrary code execution).
 */
export declare function createPythonCommands(): Command[];
/**
 * Gets all javascript command names
 */
export declare function getJavaScriptCommandNames(): string[];
/**
 * Creates javascript commands for registration (js-exec).
 * These are only registered when javascript is explicitly enabled.
 */
export declare function createJavaScriptCommands(): Command[];
/**
 * Clears the command cache (for testing)
 */
export declare function clearCommandCache(): void;
/**
 * Gets the number of loaded commands (for testing)
 */
export declare function getLoadedCommandCount(): number;
