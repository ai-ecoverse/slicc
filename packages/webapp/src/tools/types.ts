export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
  [keyword: string]: unknown;
}

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  [keyword: string]: unknown;
}

export interface BashJobProcess {
  readonly pid: number;

  readonly signal: AbortSignal;

  kill(): void;

  exit(exitCode: number | null): void;
}

export interface BashJobHost {
  spawn(command: string): BashJobProcess | null;
}

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [keyword: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;

  // biome-ignore lint/plugin: per-tool argument bag, shape declared by inputSchema.
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}
