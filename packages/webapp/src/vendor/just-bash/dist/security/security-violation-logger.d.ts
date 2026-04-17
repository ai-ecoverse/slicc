/**
 * Security Violation Logger
 *
 * Utility for tracking and reporting security violations from the
 * defense-in-depth box. Useful for monitoring, alerting, and debugging.
 *
 * IMPORTANT: This is for monitoring a SECONDARY defense layer.
 * Violations indicate potential escape attempts but the primary
 * security should prevent these from being exploitable.
 */
import type { SecurityViolation, SecurityViolationType } from "./types.js";
/**
 * Options for the security violation logger.
 */
export interface SecurityViolationLoggerOptions {
    /**
     * Maximum number of violations to store per type.
     * Default: 100
     */
    maxViolationsPerType?: number;
    /**
     * Maximum total violations to retain across all types.
     * Oldest violations are dropped when this limit is reached.
     * Default: 1000
     */
    maxViolationsTotal?: number;
    /**
     * Whether to include stack traces in logged violations.
     * Default: true
     */
    includeStackTraces?: boolean;
    /**
     * Custom handler called for each violation.
     */
    onViolation?: (violation: SecurityViolation) => void;
    /**
     * Whether to log violations to console (for debugging).
     * Default: false
     */
    logToConsole?: boolean;
}
/**
 * Summary of violations by type.
 */
export interface ViolationSummary {
    type: SecurityViolationType;
    count: number;
    firstSeen: number;
    lastSeen: number;
    paths: string[];
}
/**
 * Security Violation Logger
 *
 * Collects and summarizes security violations for analysis.
 */
export declare class SecurityViolationLogger {
    private violations;
    private violationsByType;
    private options;
    constructor(options?: SecurityViolationLoggerOptions);
    /**
     * Record a security violation.
     * This method is designed to be passed as the onViolation callback.
     */
    record(violation: SecurityViolation): void;
    /**
     * Get all recorded violations.
     */
    getViolations(): SecurityViolation[];
    /**
     * Get violations of a specific type.
     */
    getViolationsByType(type: SecurityViolationType): SecurityViolation[];
    /**
     * Get a summary of all violations by type.
     */
    getSummary(): ViolationSummary[];
    /**
     * Get total violation count.
     */
    getTotalCount(): number;
    /**
     * Check if any violations have been recorded.
     */
    hasViolations(): boolean;
    /**
     * Clear all recorded violations.
     */
    clear(): void;
    /**
     * Create a callback function suitable for DefenseInDepthConfig.onViolation.
     */
    createCallback(): (violation: SecurityViolation) => void;
}
/**
 * Create a simple violation callback that logs to console.
 */
export declare function createConsoleViolationCallback(): (violation: SecurityViolation) => void;
