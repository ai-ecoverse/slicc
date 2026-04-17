/**
 * Shell Metadata
 *
 * Shared source of truth for shell version and process information.
 * Used by both variable expansion ($BASH_VERSION, $PPID, etc.)
 * and /proc filesystem initialization.
 */
/**
 * Simulated bash version string
 */
export declare const BASH_VERSION = "5.1.0(1)-release";
/**
 * Simulated kernel version for /proc/version
 */
export declare const KERNEL_VERSION = "Linux version 5.15.0-generic (just-bash) #1 SMP PREEMPT";
/**
 * Format /proc/self/status content using virtual process info.
 * Never exposes real host process information.
 */
export declare function formatProcStatus(info: {
    pid: number;
    ppid: number;
    uid: number;
    gid: number;
}): string;
