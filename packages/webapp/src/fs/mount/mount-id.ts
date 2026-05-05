/**
 * Stable mount identity.
 *
 * Each mount carries a UUID generated at creation time and persisted in the
 * BackendDescriptor. RemoteMountCache namespaces all entries by this id, so
 * re-mounting at the same target path with a different source produces a
 * fresh cache namespace and never aliases the prior mount's entries.
 */
export function newMountId(): string {
  return crypto.randomUUID();
}
