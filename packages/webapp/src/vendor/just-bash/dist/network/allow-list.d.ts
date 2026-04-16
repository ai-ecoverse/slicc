/**
 * URL allow-list matching
 *
 * This module provides URL allow-list matching that is enforced at the fetch layer,
 * independent of any parsing or user input manipulation.
 */
import type { AllowedUrlEntry } from "./types.js";
/**
 * Parses a URL string into its components.
 * Returns null if the URL is invalid.
 */
export declare function parseUrl(urlString: string): {
    origin: string;
    pathname: string;
    href: string;
} | null;
/**
 * Normalizes an allow-list entry for consistent matching.
 * - Removes trailing slashes from origins without paths
 * - Preserves path prefixes as-is
 */
export declare function normalizeAllowListEntry(entry: string): {
    origin: string;
    pathPrefix: string;
} | null;
/**
 * Checks if a URL matches an allow-list entry.
 *
 * The matching rules are:
 * 1. Origins must match exactly (case-sensitive for scheme and host)
 * 2. Path-scoped entries match on path segment boundaries, not raw string prefix
 * 3. Ambiguous encoded separators (%2f, %5c) are rejected for path-scoped entries
 * 4. If the allow-list entry has no path (or just "/"), all paths are allowed
 *
 * @param url The URL to check (as a string)
 * @param allowedEntry The allow-list entry to match against
 * @returns true if the URL matches the allow-list entry
 */
export declare function matchesAllowListEntry(url: string, allowedEntry: string): boolean;
/**
 * Checks if a URL is allowed by any entry in the allow-list.
 *
 * @param url The URL to check
 * @param allowedUrlPrefixes The list of allowed URL prefixes (strings or objects)
 * @returns true if the URL is allowed
 */
export declare function isUrlAllowed(url: string, allowedUrlPrefixes: AllowedUrlEntry[]): boolean;
/**
 * Check if a hostname is a private/loopback IP address.
 * Only checks the string format — does not perform DNS resolution.
 */
export declare function isPrivateIp(hostname: string): boolean;
/**
 * Validates an allow-list configuration.
 * Each entry must be a full origin (scheme + host), optionally followed by a path prefix.
 * Accepts both plain strings and AllowedUrl objects.
 * Returns an array of error messages for invalid entries.
 */
export declare function validateAllowList(allowedUrlPrefixes: AllowedUrlEntry[]): string[];
