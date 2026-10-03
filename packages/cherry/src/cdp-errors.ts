export class CherryUnsupportedError extends Error {
  readonly code = -32601;
  constructor(method: string) {
    super(`Cherry: unsupported CDP method '${method}'`);
    this.name = 'CherryUnsupportedError';
  }
}
