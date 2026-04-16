/**
 * Defense-in-Depth Box
 *
 * A security layer that monkey-patches dangerous JavaScript globals during
 * bash script execution. Uses AsyncLocalStorage to track execution context,
 * so blocks only apply to code running within bash.exec() - not to concurrent
 * operations in the same process.
 *
 * IMPORTANT: This is a SECONDARY defense layer. It should never be relied upon
 * as the primary security mechanism. The primary security comes from proper
 * sandboxing, input validation, and architectural constraints.
 *
 * Key design decisions:
 * - AsyncLocalStorage for context tracking (blocks only affect sandboxed code)
 * - Reference counting for nested exec() calls
 * - Patches are process-wide but checks are context-aware
 * - Violations are recorded even in audit mode
 *
 * Dynamic import() mitigation (three layers):
 * 1. ESM loader hooks (module.register/registerHooks):
 *    - block data:/blob: URLs process-wide
 *    - block Node.js builtin specifiers in untrusted sandbox context
 * 2. Module._resolveFilename blocked — catches file-based specifiers
 * 3. Filesystem restrictions — OverlayFs writes to memory only
 *
 * Residual gap: On runtimes with only module.register() (no registerHooks),
 * loader hooks run in a separate thread and cannot read AsyncLocalStorage
 * context. In that mode, context-aware Node builtin import blocking is not
 * available.
 */
import type { DefenseInDepthConfig, DefenseInDepthHandle, DefenseInDepthStats, SecurityViolation } from "./types.js";
/**
 * Error thrown when a security violation is detected and blocking is enabled.
 */
export declare class SecurityViolationError extends Error {
    readonly violation: SecurityViolation;
    constructor(message: string, violation: SecurityViolation);
}
/**
 * Defense-in-Depth Box
 *
 * Singleton class that manages security patches during bash execution.
 * Use getInstance() to get or create the instance.
 */
export declare class DefenseInDepthBox {
    private static instance;
    private static importHooksRegistered;
    /**
     * Tracks active trusted scopes per executionId.
     * Needed for async machinery that may not preserve `store.trusted` all the
     * way into Node.js internals (e.g. dynamic import resolution hooks).
     */
    private static trustedExecutionDepth;
    private config;
    private refCount;
    private patchFailures;
    private activeExecutionIds;
    /** Reusable DefenseContext objects keyed by executionId (avoids per-.then() allocation). */
    private contextCache;
    private originalDescriptors;
    private violations;
    private activationTime;
    private totalActiveTimeMs;
    private constructor();
    /**
     * Get or create the singleton instance.
     *
     * @param config - Configuration for the defense box.
     * @throws Error if called with a config that conflicts with the existing instance's
     *         security-relevant settings (enabled, auditMode). This prevents a weaker
     *         first caller from silently downgrading protection for later callers.
     */
    static getInstance(config?: DefenseInDepthConfig | boolean): DefenseInDepthBox;
    /**
     * Reset the singleton instance. Only use in tests.
     */
    static resetInstance(): void;
    /**
     * Check if the current async context is within sandboxed execution.
     */
    static isInSandboxedContext(): boolean;
    /**
     * Get the current execution ID if in a sandboxed context.
     */
    static getCurrentExecutionId(): string | undefined;
    private static enterTrustedScope;
    private static leaveTrustedScope;
    private static isTrustedScopeActive;
    /**
     * Check if a defense execution ID is still live (its handle is not deactivated).
     */
    private isExecutionIdActive;
    /**
     * Get or create a cached DefenseContext for an executionId.
     * Avoids allocating a new {sandboxActive, executionId} object on every
     * Promise.then / timer call.
     */
    private getCachedContext;
    /**
     * Return an active execution ID to bind callback context.
     * When multiple executions are active, this intentionally selects one
     * active ID so callback execution stays fail-closed.
     */
    private getPreferredActiveExecutionId;
    /**
     * Bind a callback to the current defense AsyncLocalStorage context.
     *
     * Useful for infrastructure callbacks that may execute later via pre-captured
     * timer references, while still needing executionId/trace continuity.
     *
     * Note: this intentionally does NOT preserve `trusted` mode. Trusted execution
     * is meant to stay tightly scoped to the immediate infrastructure operation.
     */
    static bindCurrentContext<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
    /**
     * Check if defense-in-depth is enabled and functional.
     * Returns false if AsyncLocalStorage is unavailable or config.enabled is false.
     */
    isEnabled(): boolean;
    /**
     * Update configuration. Only affects future activations.
     */
    updateConfig(config: Partial<DefenseInDepthConfig>): void;
    /**
     * Activate the defense box. Returns a handle for scoped execution.
     *
     * Usage:
     * ```
     * const { run, deactivate } = box.activate();
     * try {
     *   await run(async () => {
     *     // Code here is protected
     *   });
     * } finally {
     *   deactivate();
     * }
     * ```
     */
    activate(): DefenseInDepthHandle;
    /**
     * Force deactivation, restoring all patches regardless of ref count.
     * Use for error recovery only.
     */
    forceDeactivate(): void;
    /**
     * Check if patches are currently applied.
     */
    isActive(): boolean;
    /**
     * Get statistics about the defense box.
     */
    getStats(): DefenseInDepthStats;
    /**
     * Get the list of patch paths that failed during the last activation.
     */
    getPatchFailures(): string[];
    /**
     * Clear stored violations. Useful for testing.
     */
    clearViolations(): void;
    /**
     * Get a human-readable path for a target object and property.
     */
    private getPathForTarget;
    /**
     * Run a function as trusted infrastructure code.
     * Blocking is suspended for the current async context only — other
     * concurrent exec() calls remain protected.
     *
     * Uses AsyncLocalStorage to scope the trust, so async operations
     * spawned inside the callback inherit the trusted state.
     */
    static runTrusted<T>(fn: () => T): T;
    /**
     * Async version of runTrusted.
     */
    static runTrustedAsync<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Check if current context should be blocked.
     * Returns false in audit mode, browser environment, outside sandboxed context,
     * inside runTrusted(), or when the immediate caller is a Node.js bundled dep.
     */
    private shouldBlock;
    /**
     * Record a violation and optionally invoke the callback.
     */
    private recordViolation;
    /**
     * Create a blocking proxy for a function.
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
     * Protect against .constructor.constructor escape vector.
     *
     * The pattern `{}.constructor.constructor` accesses Function via:
     * - {}.constructor → Object (via Object.prototype.constructor)
     * - Object.constructor → Function (via Function.prototype.constructor)
     *
     * By patching Function.prototype.constructor to return our blocked proxy,
     * we block the escape vector without breaking normal .constructor access.
     */
    private protectConstructorChain;
    /**
     * Protect Error.prepareStackTrace from being set in sandbox context.
     *
     * The attack vector is:
     * ```
     * Error.prepareStackTrace = (err, stack) => {
     *   return stack[0].getFunction().constructor; // Gets Function
     * };
     * const F = new Error().stack;
     * F("return process")();
     * ```
     *
     * We only block SETTING, not reading, because V8 reads it internally
     * when creating error stack traces.
     */
    private protectErrorPrepareStackTrace;
    /**
     * Protect Promise.then callback lifetime across deactivate boundaries.
     *
     * Callbacks registered in sandbox context are wrapped with an execution-id
     * liveness check. If they run after the originating handle is deactivated,
     * they are blocked even if global patches have already been restored.
     */
    private protectPromiseThen;
    /**
     * Patch a prototype's constructor property to block access in sandbox context.
     */
    private patchPrototypeConstructor;
    /**
     * Protect process.mainModule from being accessed or set in sandbox context.
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
     * Protect process.execPath from being read or set in sandbox context.
     *
     * process.execPath is a string primitive (not an object), so it cannot be
     * proxied via the normal blocked globals mechanism. We use Object.defineProperty
     * with getter/setter (same pattern as protectProcessMainModule).
     */
    private protectProcessExecPath;
    /**
     * Lock well-known Symbol properties on built-in constructors/prototypes.
     *
     * Instead of freezing entire prototypes (which breaks Node.js internals),
     * we make specific Symbol properties non-configurable so they can't be
     * replaced. This prevents:
     * - Symbol.species hijacking (controls .map/.filter/.slice return types)
     * - Symbol.iterator hijacking (controls for...of and spread)
     * - Symbol.toPrimitive hijacking (controls type coercion)
     */
    private lockWellKnownSymbols;
    /**
     * Block Proxy.revocable to prevent bypassing Proxy constructor blocking.
     *
     * Proxy.revocable internally uses the real Proxy constructor, so it bypasses
     * our blocking proxy on globalThis.Proxy. We replace it with a wrapper that
     * checks the sandbox context before delegating to the original.
     */
    private protectProxyRevocable;
    /**
     * Block dynamic import() escape vectors via ESM loader hooks.
     *
     * Uses Node.js module.registerHooks() (23.5+, synchronous) or
     * module.register() (20.6+, async hooks in separate thread) to install
     * ESM loader hooks that reject dangerous specifiers.
     *
     * registerHooks() runs in-thread and can read AsyncLocalStorage. We use it
     * to block Node.js builtin specifiers (node:* and bare builtins) only in
     * untrusted sandbox context while still allowing trusted infrastructure
     * imports (runTrusted/runTrustedAsync).
     *
     * register() hooks run in a separate loader thread and cannot read
     * AsyncLocalStorage. In that fallback mode, only data:/blob: blocking is
     * enforced here.
     *
     * This is process-wide and permanent (hooks cannot be unregistered).
     * Only applied once per process regardless of how many DefenseInDepthBox
     * instances are created.
     *
     * Combined with Module._resolveFilename blocking (file-based specifiers),
     * this closes the import() escape vector except for specifiers that bypass
     * both the ESM loader and CJS resolution (none known).
     */
    private protectDynamicImport;
    /**
     * Protect Module._load from being called in sandbox context.
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
     * Protect Module._resolveFilename from being called in sandbox context.
     *
     * Module._resolveFilename is called for both require() and import() resolution.
     * Blocking it catches file-based import() specifiers:
     *   import('./malicious.js')  // _resolveFilename is called to resolve the path
     *
     * data: and blob: URLs are handled separately by protectDynamicImport()
     * via ESM loader hooks.
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
