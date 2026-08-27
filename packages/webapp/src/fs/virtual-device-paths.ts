/**
 * Synthetic `/dev/*` paths the filesystem layers answer for themselves, in two
 * strictly separate flavors: paths whose write is a genuine no-op
 * ({@link NO_OP_WRITE_DEVICE_PATHS}) and the shell's ephemeral descriptors
 * ({@link isEphemeralFdPath}), whose payload is read back and therefore must
 * never be discarded. Keep them apart — the whole point of the split is that a
 * single list would be wrong for one of the two.
 *
 * Canonical list of virtual device files (`/dev/*`) whose write is a genuine
 * no-op. This is the single source of truth shared by two consumers that would
 * otherwise hardcode the same literals and drift:
 *
 *   - `RestrictedFS` (`restricted-fs.ts`) registers the device behavior and
 *     keys `VIRTUAL_DEVICES` off {@link DEV_NULL}.
 *   - The sudoers matcher (`base/sudoers.ts`) permits CONTENT writes
 *     (`writeFile`) to these paths so scoops never hit an approval prompt for a
 *     write that discards its payload.
 *
 * Only add a path here when its device `write` truly discards the payload. A
 * device whose write has observable effects MUST NOT be listed — its writes
 * should still be gated by the normal sudoers policy. Adding a qualifying path
 * here auto-wires the SUDOERS MATCHER only (it iterates this shared list).
 * `RestrictedFS` does NOT auto-wire: it keys `VIRTUAL_DEVICES` off the specific
 * device constants and each device needs its own `stat`/`read`/`readText`/`write`
 * implementation there, so a new path also requires a matching `VIRTUAL_DEVICES`
 * entry (with its own no-op `write`) before the write is actually discarded.
 *
 * This module intentionally imports nothing so it can be consumed by the pure,
 * framework-free sudoers matcher without pulling in the filesystem graph (no
 * import cycle).
 */

/** The canonical `/dev/null` path (its write discards all input). */
export const DEV_NULL = '/dev/null';

/**
 * Matches `/dev/fd/<n>`, a decimal descriptor number under the directory that
 * holds the shell's ephemeral file descriptors — the backing paths just-bash
 * hands to the outer command for process substitution (`<(cmd)`, `>(cmd)`),
 * numbered downward from 63 exactly as bash numbers them.
 */
const DEV_FD_PATH = /^\/dev\/fd\/(0|[1-9][0-9]*)$/;

/**
 * Whether `path` (already-normalized) is an ephemeral shell descriptor.
 *
 * This is a deliberate SIBLING of {@link NO_OP_WRITE_DEVICE_PATHS}, not a
 * member of it: a process-substitution descriptor's payload is NOT discarded —
 * the consuming command in the same pipeline reads it straight back, so
 * treating it as a no-op write would turn `cat <(echo hi)` from an error into
 * silently empty output. What the two concepts share is only the reason they
 * bypass the sudoers policy: the path is minted by the shell for the duration
 * of one command, so there is no user-meaningful subject for an approval prompt
 * to be about, and a scoop stalling on one is a harness bug (#2502).
 *
 * Consumers:
 *   - The sudoers matcher (`base/sudoers.ts`) resolves these paths to
 *     `nopasswd-allow` for BOTH ops, so a sandboxed scoop's default
 *     `require-approval` disposition can never escalate a descriptor write to
 *     the cone (an fd number varies per invocation, so no "Always" grant could
 *     ever pre-empt the prompt).
 *   - `RestrictedFS` (`restricted-fs.ts`) backs them with a private
 *     `EphemeralFdStore` (`ephemeral-fd-store.ts`) instead of the sandboxed
 *     tree, so the bytes are readable back inside the sandbox without
 *     `/dev/fd` becoming a real, listable, cross-sandbox-visible VFS location.
 *
 * The cone runs against an unrestricted `VirtualFS` and is unaffected by both:
 * it already writes and reads these paths as ordinary files.
 */
export function isEphemeralFdPath(path: string): boolean {
  return DEV_FD_PATH.test(path);
}

/** All virtual-device paths whose `write` is a no-op. */
export const NO_OP_WRITE_DEVICE_PATHS = [DEV_NULL] as const;

/** Set form of {@link NO_OP_WRITE_DEVICE_PATHS} for O(1) membership checks. */
export const NO_OP_WRITE_DEVICE_PATH_SET: ReadonlySet<string> = new Set(NO_OP_WRITE_DEVICE_PATHS);

/** Whether `path` (already-normalized) is a no-op-write virtual device. */
export function isNoOpWriteDevicePath(path: string): boolean {
  return NO_OP_WRITE_DEVICE_PATH_SET.has(path);
}
