/**
 * Convert MCP server tools into native pi-compatible `AgentTool` instances.
 *
 * Each tool is named `mcp__<server>__<tool>` (Pi convention, sanitized to
 * 64 chars of `[A-Za-z0-9_]`). MCP content blocks are converted into agent
 * results. Text over 20 KB is truncated in the middle (matching Pi's
 * behavior) and the full text is written to `/tmp/mcp/<id>.txt` in the VFS.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Tool } from '@earendil-works/pi-mcp';
import { createLogger } from '../../base/logger.js';
import type { McpCallToolResult, McpConnection } from './connection-manager.js';
import { mcpAgentToolNames, resolveToolExposure } from './connection-manager.js';
import type { McpExposureMode, McpToolArgs } from './types.js';

const log = createLogger('mcp-agent-tools');

const MCP_TEXT_TRUNCATION_BYTES = 20 * 1024;
const TRUNCATION_MARKER = '\n\n--- [truncated; full output at /tmp/mcp/{id}.txt] ---\n\n';

export interface ToAgentToolsOptions {
  serverName: string;
  tools: Tool[];
  connection: McpConnection;
  exposure?: McpExposureMode;
  toolExposure?: Record<string, McpExposureMode>;
  writeOverflow?: (id: string, text: string) => Promise<void>;
}

export function toAgentTools(options: ToAgentToolsOptions): AgentTool[] {
  const { serverName, tools, connection, exposure, toolExposure, writeOverflow } = options;

  const directTools: AgentTool[] = [];
  const names = mcpAgentToolNames(
    serverName,
    tools
      .filter((tool) => resolveToolExposure(tool.name, exposure, toolExposure) === 'direct')
      .map((tool) => tool.name)
  );

  for (const tool of tools) {
    const mode = resolveToolExposure(tool.name, exposure, toolExposure);
    if (mode !== 'direct') continue;

    const agentToolName = names.get(tool.name)!;
    const agentTool: AgentTool = {
      name: agentToolName,
      label: `mcp:${serverName}/${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      parameters: (tool.inputSchema ?? {
        type: 'object',
        properties: {},
      }) as AgentTool['parameters'],
      ...(tool.outputSchema
        ? { outputSchema: tool.outputSchema as AgentTool['outputSchema'] }
        : {}),
      async execute(
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal
      ): Promise<AgentToolResult> {
        const args = (params ?? {}) as McpToolArgs;
        try {
          const result = await connection.callTool(tool.name, args, { signal });
          const content = convertToLlmContent(result);
          const truncated = await truncateContent(content, toolCallId, writeOverflow);
          return {
            content: truncated,
            details: undefined,
            ...(result.structuredContent
              ? {
                  structuredContent:
                    result.structuredContent as import('@earendil-works/pi-ai').JsonValue,
                }
              : {}),
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (err) {
          log.warn('MCP tool call failed', {
            server: serverName,
            tool: tool.name,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
      },
    };

    directTools.push(agentTool);
  }

  return directTools;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function convertContentBlock(
  block: McpCallToolResult['content'][number]
): ContentBlock | undefined {
  switch (block.type) {
    case 'text':
      if ('text' in block && typeof block.text === 'string') {
        return { type: 'text', text: block.text };
      }
      return undefined;
    case 'image':
      if ('data' in block && 'mimeType' in block) {
        return { type: 'image', data: block.data as string, mimeType: block.mimeType as string };
      }
      return undefined;
    case 'resource':
      return convertResourceBlock(block);
    default:
      return { type: 'text', text: `[${block.type ?? 'unknown'}]` };
  }
}

function convertResourceBlock(block: McpCallToolResult['content'][number]): ContentBlock {
  if (!('resource' in block)) {
    return { type: 'text', text: '[resource: unknown]' };
  }
  const res = block.resource as { text?: string; blob?: string; uri?: string; mimeType?: string };
  if (res.text) {
    return { type: 'text', text: res.text };
  }
  if (res.mimeType?.startsWith('image/') && res.blob) {
    return { type: 'image', data: res.blob, mimeType: res.mimeType };
  }
  return { type: 'text', text: `[resource: ${res.uri ?? 'unknown'}]` };
}

function convertToLlmContent(result: McpCallToolResult): ContentBlock[] {
  const out: ContentBlock[] = [];

  for (const block of result.content) {
    const converted = convertContentBlock(block);
    if (converted) out.push(converted);
  }

  if (out.length === 0 && result.structuredContent) {
    out.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  }

  if (out.length === 0) {
    out.push({ type: 'text', text: '(empty result)' });
  }

  return out;
}

async function truncateContent(
  content: ContentBlock[],
  toolCallId: string,
  writeOverflow?: (id: string, text: string) => Promise<void>
): Promise<ContentBlock[]> {
  const encoder = new TextEncoder();
  let totalTextBytes = 0;
  for (const block of content) {
    if (block.type === 'text') totalTextBytes += encoder.encode(block.text).length;
  }
  if (totalTextBytes <= MCP_TEXT_TRUNCATION_BYTES) return content;

  let budget = MCP_TEXT_TRUNCATION_BYTES;
  const result: ContentBlock[] = [];
  let overflowWritten = false;

  for (const block of content) {
    if (block.type !== 'text') {
      result.push(block);
      continue;
    }
    const blockBytes = encoder.encode(block.text);
    if (blockBytes.length <= budget) {
      budget -= blockBytes.length;
      result.push(block);
      continue;
    }

    if (!overflowWritten && writeOverflow) {
      overflowWritten = true;
      const id = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fullText = content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      try {
        await writeOverflow(id, fullText);
      } catch (err) {
        log.debug('failed to write MCP overflow', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (budget <= 0) continue;
    const half = Math.floor(budget / 2);
    const head = new TextDecoder().decode(blockBytes.slice(0, half));
    const tail = new TextDecoder().decode(blockBytes.slice(blockBytes.length - half));
    const id = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const marker = TRUNCATION_MARKER.replace('{id}', id);
    result.push({ type: 'text' as const, text: head + marker + tail });
    budget = 0;
  }

  return result;
}

export type { McpExposureMode };
