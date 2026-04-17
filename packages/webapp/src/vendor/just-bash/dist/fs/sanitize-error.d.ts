/**
 * Error message sanitization utility.
 *
 * This module has NO Node.js dependencies (no `node:fs`, etc.) so it can
 * safely be imported in browser bundles.
 */
/**
 * Sanitize an error message to strip common real OS paths and stack traces.
 *
 * Preserves virtual paths that don't match the common host prefixes used by
 * the default runtime.
 */
export declare function sanitizeErrorMessage(message: string): string;
/**
 * Aggressive sanitizer for host-originated errors such as worker/bootstrap
 * failures. This also scrubs file:// URLs and additional runtime roots that
 * are common in hosted environments.
 */
export declare function sanitizeHostErrorMessage(message: string): string;
