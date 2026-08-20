/**
 * Tool-contract types for the legacy `tools/` factories.
 *
 * These live in the `tools/` layer so tool modules import them sideways
 * (`./types.js`) instead of up-the-stack into `core/`. `core/` consumes them
 * as a legal down-edge (`core/` → `tools/`).
 */

/**
 * A single JSON Schema property descriptor — the value stored under each key of
 * an object schema's `properties` map (e.g. `{ type: 'string', description }`).
 * Only the keywords the tool factories actually emit are named; the open index
 * signature keeps the rest of the JSON Schema vocabulary (`enum`, `items`,
 * `default`, …) representable without falling back to an untyped bag.
 */
export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
  [keyword: string]: unknown;
}

/**
 * A JSON Schema object — the `{ type: 'object', properties, required }` form
 * callers pass around verbatim (a scoop's `structuredOutputSchema`, the
 * `agent --schema-b64` payload). Named so those fields do not fall back to an
 * untyped bag; the open index signature keeps the rest of the JSON Schema
 * vocabulary representable. `type` is optional because a schema is forwarded
 * to the model as authored, not normalized here.
 */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  [keyword: string]: unknown;
}

/**
 * One kernel process standing in for a single `bash` invocation, as seen from
 * the tool layer. `tools/` sits below `kernel/` in the layer stack, so the
 * `ProcessManager` is never imported here — `ScoopContext` implements this
 * handle over it (see {@link BashJobHost}).
 *
 * The point of the handle is that a bash run becomes a real pid: `ps` lists it,
 * `kill <pid>` reaches it, and a SIGKILL fans out over the ppid tree to every
 * realm descendant (`node` / `python3` / `.jsh` workers), which is the only
 * uncatchable stop available in a browser.
 */
export interface BashJobProcess {
  /** Kernel pid. Surfaced to the model so it can `ps` / `kill` the job. */
  readonly pid: number;
  /**
   * Aborts when a terminating signal reaches this pid — `kill` from any shell,
   * or the fan-out from an ancestor (turn cancel, `drop_scoop`).
   */
  readonly signal: AbortSignal;
  /**
   * SIGKILL this pid AND its descendants. Realm-backed descendants are
   * `worker.terminate()`d synchronously; in-worker just-bash work has no worker
   * to terminate and only stops cooperatively, so callers must still abort.
   */
  kill(): void;
  /** Reap the record. `null` derives the code from the signal that killed it. */
  exit(exitCode: number | null): void;
}

/**
 * Spawns a {@link BashJobProcess} per `bash` invocation. Returns `null` when the
 * context has no process manager (tests, floats without a kernel host), in which
 * case the run proceeds unregistered exactly as it did before.
 */
export interface BashJobHost {
  spawn(command: string): BashJobProcess | null;
}

/** JSON Schema for tool input parameters. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [keyword: string]: unknown;
}

/**
 * Legacy tool definition for backwards compatibility with existing tools.
 * Used by src/tools/ factories. The tool adapter converts these to AgentTool.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  // The arguments the model produced for THIS tool, whose fields are declared by
  // that tool's own `inputSchema` and differ per tool. One shared interface here
  // could only restate "some string keys", which is what the type already says;
  // naming the real shape means making `ToolDefinition` generic over its schema,
  // a signature change across every legacy tool factory and the adapter — worth
  // doing, but not behaviour-preservingly in a debt-payoff PR.
  // biome-ignore lint/plugin: per-tool argument bag, shape declared by inputSchema.
  execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

/** Legacy tool result. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}
