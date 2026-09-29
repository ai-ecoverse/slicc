/**
 * File modes for extracted package files, as npm sets them.
 *
 * A tar entry with any execute bit becomes 0755 and everything else 0644:
 * no setuid/setgid/sticky, no group or world write. Tools find their helpers
 * by the execute bit (git runs `libexec/git-core/git-submodule` only when it
 * is executable), so dropping modes breaks packages that ship scripts.
 */

export const EXECUTABLE_MODE = 0o755;
export const REGULAR_MODE = 0o644;

/** npm's normalization of a tar header mode (`undefined` = no header mode). */
export function normalizeFileMode(mode: number | undefined): number {
  return mode !== undefined && (mode & 0o111) !== 0 ? EXECUTABLE_MODE : REGULAR_MODE;
}
