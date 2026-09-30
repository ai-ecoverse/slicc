/**
 * The `codemode` agent tool: runs JavaScript in a QuickJS sandbox where the
 * only capabilities are calling registered tools. Scripts see `tools[name](args)`
 * for every tool exposed to codemode by that MCP server.
 *
 * The sandbox loads pi-codemode's `CodemodeSandbox`, which spawns a
 * DedicatedWorker per execution (the host-side `node:worker_threads` shim
 * in `shims/worker-threads.ts` adapts it for the browser).
 *
 * WASM: `quickjs.wasm` is fetched from a CDN on first use (~637 KB) and
 * compiled once via the stub in `stubs/pi-codemode-wasm-stub.ts`.
 *
 * SharedArrayBuffer: the hosted leader has it (Document-Isolation-Policy);
 * non-isolated contexts (Cherry, pre-137 Chrome) fall back to plain
 * `ArrayBuffer` — safe because `worker.terminate()` stops wasm threads.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type {
  CodemodeResult,
  CodemodeSandbox,
  CodemodeTool as PiCodemodeTool,
} from '@earendil-works/pi-codemode';
import { createLogger } from '../../base/logger.js';
import type { McpCallToolResult, McpConnection } from './connection-manager.js';
import { mcpAgentToolName, resolveToolExposure } from './connection-manager.js';
import type { McpExposureMode, McpToolArgs } from './types.js';

const log = createLogger('mcp-codemode');

const CODEMODE_TOOL_NAME = 'codemode';
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const CODEMODE_TIMEOUT_MS = 300_000;

export interface CodemodeToolOptions {
  serverName: string;
  tools: import('@earendil-works/pi-mcp').Tool[];
  connection: McpConnection;
  exposure?: McpExposureMode;
  toolExposure?: Record<string, McpExposureMode>;
}

let sandboxInstance: CodemodeSandbox | null = null;

async function getOrCreateSandbox(): Promise<CodemodeSandbox> {
  if (sandboxInstance) return sandboxInstance;

  const { CodemodeSandbox: SandboxClass, loadQuickJSWasm } = await import(
    '@earendil-works/pi-codemode'
  );

  ensureSharedArrayBuffer();

  const workerUrl = new URL('../kernel/codemode-worker.ts', import.meta.url);
  const wasm = loadQuickJSWasm();

  sandboxInstance = new SandboxClass({
    timeoutMs: CODEMODE_TIMEOUT_MS,
    memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
    wasm,
    workerUrl,
  });

  return sandboxInstance;
}

function ensureSharedArrayBuffer(): void {
  if (typeof SharedArrayBuffer === 'function') return;
  // Non-isolated contexts lack SAB. pi-codemode uses it only for the
  // interrupt flag (Atomics.store/load). Without SAB, `worker.terminate()`
  // is the only way to stop a runaway script, which the browser supports.
  (globalThis as unknown as { SharedArrayBuffer: unknown }).SharedArrayBuffer = ArrayBuffer;
}

export function createCodemodeAgentTool(options: CodemodeToolOptions): AgentTool | null {
  const { serverName, tools, connection, exposure, toolExposure } = options;

  const codemodeTools = tools.filter((tool) => {
    const mode = resolveToolExposure(tool.name, exposure, toolExposure);
    return mode === 'codemode' || mode === 'codemode-deferred';
  });

  if (codemodeTools.length === 0) return null;

  const toolDescriptions = codemodeTools
    .map(
      (t) => `- \`tools[${JSON.stringify(t.name)}](args)\`: ${t.description ?? '(no description)'}`
    )
    .join('\n');

  const description = `Run JavaScript to orchestrate MCP tool calls from server "${serverName}".
Scripts run in a QuickJS sandbox with access to the following tools via \`tools["name"](args)\`:
${toolDescriptions}

Top-level \`await\` and \`return\` work. No fetch, no filesystem, no timers — only tool calls.`;

  return {
    name: mcpAgentToolName(serverName, CODEMODE_TOOL_NAME),
    label: `mcp:${serverName}/codemode`,
    description,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript source to execute in the sandbox.',
        },
      },
      required: ['code'],
    },
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal
    ): Promise<AgentToolResult> {
      const args = (params ?? {}) as { code?: string };
      const code = args.code ?? '';

      try {
        const sandbox = await getOrCreateSandbox();

        const sandboxTools: PiCodemodeTool[] = codemodeTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as PiCodemodeTool['inputSchema'],
          async execute(toolArgs: unknown, ctx: { signal: AbortSignal }): Promise<unknown> {
            const callArgs = (toolArgs ?? {}) as McpToolArgs;
            const result: McpCallToolResult = await connection.callTool(tool.name, callArgs, {
              signal: ctx.signal,
            });
            if (result.isError) {
              const text = result.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
              throw new Error(text || `Tool "${tool.name}" failed`);
            }
            if (result.structuredContent) return result.structuredContent;
            return result.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
          },
        }));

        for (const t of sandboxTools) sandbox.registerTool(t);

        let result: CodemodeResult;
        try {
          result = await sandbox.execute(code, { signal });
        } finally {
          for (const t of sandboxTools) sandbox.unregisterTool(t.name);
        }

        return formatResult(result);
      } catch (err) {
        log.warn('codemode execution failed', {
          server: serverName,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Codemode error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}

function formatResult(result: CodemodeResult): AgentToolResult {
  const items = result.output.map((item) =>
    item.type === 'text'
      ? { type: 'text' as const, text: item.text }
      : { type: 'image' as const, data: item.data, mimeType: item.mimeType }
  );

  if (result.ok && result.value !== undefined) {
    items.push({
      type: 'text' as const,
      text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value),
    });
  }

  if (!result.ok) {
    const { error } = result;
    const errorText =
      error.kind === 'script'
        ? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
        : `${error.kind}: ${error.message}`;
    items.push({ type: 'text' as const, text: `Script error:\n${errorText}` });
  }

  const wallCalls = result.calls
    .map((c) => `${c.name} (${c.status}, ${c.durationMs.toFixed(0)}ms)`)
    .join(', ');

  const header = `${result.ok ? 'Script completed' : 'Script failed'}${
    result.calls.length > 0 ? `\nTool calls: ${wallCalls}` : ''
  }\n`;

  if (items.length === 0) {
    items.push({ type: 'text' as const, text: '(empty result)' });
  }

  return {
    content: [{ type: 'text' as const, text: header }, ...items],
    details: undefined,
    ...(result.ok ? {} : { isError: true }),
  };
}

export async function closeSandbox(): Promise<void> {
  if (sandboxInstance) {
    await sandboxInstance.close();
    sandboxInstance = null;
  }
}
