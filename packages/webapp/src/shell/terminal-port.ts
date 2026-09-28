export interface TerminalLease {
  readonly cols: number;
  readonly rows: number;

  write(bytes: Uint8Array): void;

  onInput(listener: (bytes: Uint8Array) => void): void;
  onResize(listener: (cols: number, rows: number) => void): void;

  release(): void;
}

export interface TerminalPort {
  lease(): TerminalLease | null;
}
