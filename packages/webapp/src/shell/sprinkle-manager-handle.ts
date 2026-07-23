/** Sprinkle metadata consumed by the shell command. */
export interface ShellSprinkle {
  name: string;
  title: string;
  path: string;
}

/** Worker-safe slice of the sprinkle manager used by the shell command. */
export interface SprinkleManagerHandle {
  refresh(): Promise<void>;
  available(): ShellSprinkle[];
  opened(): string[];
  open(name: string): Promise<void>;
  close(name: string): void;
  reload(name: string): Promise<void>;
  sendToSprinkle(name: string, data: unknown): void;
}
