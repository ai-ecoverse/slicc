/**
 * CDP error Cherry uses for unimplemented / capability-denied methods.
 * Split from the host-handler module so ui-only embeds can throw it without
 * pulling the full synthetic-CDP implementation into a size-capped bundle.
 */

export class CherryUnsupportedError extends Error {
  readonly code = -32601;
  constructor(method: string) {
    super(`Cherry: unsupported CDP method '${method}'`);
    this.name = 'CherryUnsupportedError';
  }
}
