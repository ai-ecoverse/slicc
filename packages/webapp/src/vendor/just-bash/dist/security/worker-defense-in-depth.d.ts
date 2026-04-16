/**
 * Worker Defense-in-Depth
 *
 * A simplified version of DefenseInDepthBox designed for use in Worker threads.
 * Since workers have their own isolated V8 context, we don't need AsyncLocalStorage
 * to track execution context - the entire worker IS the sandboxed context.
 *
 * Key differences from DefenseInDepthBox:
 * - No AsyncLocalStorage (always blocks, no context tracking needed)
 * - Single activation model (apply patches once at worker startup)
 * - Violations reported via callback (typically postMessage to parent)
 *
 * Usage in a worker:
 * ```typescript
 * import { parentPort } from 'node:worker_threads';
 * import { WorkerDefenseInDepth } from '../security/worker-defense-in-depth.js';
 *
 * // Apply patches at worker startup
 * const defense = new WorkerDefenseInDepth({
 *   onViolation: (v) => parentPort?.postMessage({ type: 'security-violation', violation: v }),
 * });
 *
 * // All code in the worker is now protected
 * // Attempting Function, eval, etc. will throw SecurityViolationError
 * ```
 *
 * Constructor Protection:
 * Function.prototype.constructor returns a proxy that allows property reads
 * (e.g., `.constructor.name` for type introspection) but blocks invocation
 * (e.g., `.constructor("code")` for dynamic code execution).
 *
 * IMPORTANT: This is a SECONDARY defense layer. It should never be relied upon
 * as the primary security mechanism. The primary security comes from proper
 * sandboxing, input validation, and architectural constraints.
 *
 * Dynamic import() mitigation (three layers):
 * 1. Module._resolveFilename blocked — catches file-based specifiers
 * 2. Main-thread ESM loader hooks block data:/blob: URLs (not in workers)
 * 3. Filesystem restrictions — OverlayFs writes to memory only
 *
 * Note: ESM loader hooks are registered by DefenseInDepthBox in the main
 * thread. Workers inherit the hooks automatically. Worker-level registration
 * is not needed (and would require require('node:module') which is blocked).
 */
import type { DefenseInDepthConfig, SecurityViolation } from "./types.js";
/**
 * Error thrown when a security violation is detected.
 */
export declare class WorkerSecurityViolationError extends Error {
    readonly violation: SecurityViolation;
    constructor(message: string, violation: SecurityViolation);
}
/**
 * Statistics about the worker defense layer.
 */
export interface WorkerDefenseStats {
    /** Total number of violations detected */
    violationsBlocked: number;
    /** List of all violations detected (capped to prevent memory issues) */
    violations: SecurityViolation[];
    /** Whether patches are currently active */
    isActive: boolean;
}
/**
 * Worker Defense-in-Depth
 *
 * Applies security patches to dangerous JavaScript globals in a worker context.
 * Unlike DefenseInDepthBox, this is designed for workers where the entire
 * execution context is sandboxed.
 */
export declare class WorkerDefenseInDepth {
    private config;
    private isActivated;
    private originalDescriptors;
    private violations;
    private executionId;
    /**
     * Original Proxy constructor, captured before patching.
     * This is captured at instance creation time to ensure we get the unpatched version.
     */
    private originalProxy;
    /**
     * Recursion guard to prevent infinite loops when proxy traps trigger
     * code that accesses the same proxied object (e.g., process.env).
     */
    private inTrap;
    /**
     * Create and activate the worker defense layer.
     *
     * @param config - Configuration for the defense layer
     */
    constructor(config: DefenseInDepthConfig);
    /**
     * Get statistics about the defense layer.
     */
    getStats(): WorkerDefenseStats;
    /**
     * Clear stored violations. Useful for testing.
     */
    clearViolations(): void;
    /**
     * Get the execution ID for this worker.
     */
    getExecutionId(): string;
    /**
     * Deactivate the defense layer and restore original globals.
     * Typically only needed for testing.
     */
    deactivate(): void;
    /**
     * Activate the defense layer by applying patches.
     */
    private activate;
    /**
     * Get a human-readable path for a target object and property.
     */
    private getPathForTarget;
    /**
     * Record a violation and invoke the callback.
     * In worker context, blocking always happens (no audit mode context check).
     */
    private recordViolation;
    /**
     * Create a blocking proxy for a function.
     * In worker context, always blocks (no context check needed).
     */
    private createBlockingProxy;
    /**
     * Create a blocking proxy for an object (blocks all property access).
     */
    private createBlockingObjectProxy;
    /**
     * Apply security patches to dangerous globals.
     */
    private applyPatches;
    /**
     * Lock well-known Symbol properties on built-in constructors/prototypes.
     */
    private lockWellKnownSymbols;
    /**
     * Block Proxy.revocable to prevent bypassing Proxy constructor blocking.
     *
     * Proxy.revocable internally uses the real Proxy constructor, so it bypasses
     * our blocking proxy on globalThis.Proxy. We replace it with a wrapper that
     * always blocks in worker context.
     */
    private protectProxyRevocable;
    /**
     * Protect against .constructor.constructor escape vector.
     * @param excludeTypes - Set of violation types to skip
     */
    private protectConstructorChain;
    /**
     * Protect Error.prepareStackTrace from being set.
     */
    private protectErrorPrepareStackTrace;
    /**
     * Patch a prototype's constructor property.
     *
     * Returns a proxy that allows reading properties (like .name) but blocks
     * calling the constructor as a function (which would allow code execution).
     */
    private patchPrototypeConstructor;
    /**
     * Protect process.mainModule from being accessed or set.
     *
     * The attack vector is:
     * ```
     * process.mainModule.require('child_process').execSync('whoami')
     * process.mainModule.constructor._load('vm')
     * ```
     *
     * process.mainModule may be undefined in ESM contexts but could exist in
     * CommonJS workers. We block both reading and setting.
     */
    private protectProcessMainModule;
    /**
     * Protect process.execPath from being read or set in worker context.
     *
     * process.execPath is a string primitive (not an object), so it cannot be
     * proxied via the normal blocked globals mechanism. We use Object.defineProperty
     * with getter/setter (same pattern as protectProcessMainModule).
     */
    private protectProcessExecPath;
    /**
     * Protect process.connected from being read or set in worker context.
     *
     * process.connected is a boolean primitive (not an object), so it cannot be
     * proxied via the normal blocked globals mechanism. We use Object.defineProperty
     * with getter/setter (same pattern as protectProcessExecPath).
     *
     * Only protects if process.connected exists (IPC contexts).
     */
    private protectProcessConnected;
    /**
     * Protect Module._load from being called.
     *
     * The attack vector is:
     * ```
     * module.constructor._load('child_process')
     * require.main.constructor._load('vm')
     * ```
     *
     * We access the Module class and replace _load with a blocking proxy.
     */
    private protectModuleLoad;
    /**
     * Protect Module._resolveFilename from being called in worker context.
     *
     * Module._resolveFilename is called for both require() and import() resolution.
     * Blocking it catches file-based import() specifiers.
     *
     * data: and blob: URLs are handled by ESM loader hooks registered
     * in the main thread (DefenseInDepthBox.protectDynamicImport).
     */
    private protectModuleResolveFilename;
    /**
     * Apply a single patch to a blocked global.
     */
    private applyPatch;
    /**
     * Restore all original values.
     */
    private restorePatches;
}
