/**
 * Instance id shared by the page and the kernel worker.
 *
 * The kernel worker binds the id the page minted. Shell code reads it
 * here so it does not import `core/` (that would be a layer back-edge).
 * A null id uses an unscoped channel name, which tests rely on.
 */

let instanceId: string | null = null;

export function bindMcpServeInstance(id: string | null | undefined): void {
  instanceId = id ?? null;
}

export function mcpServeInstanceId(): string | null {
  return instanceId;
}
