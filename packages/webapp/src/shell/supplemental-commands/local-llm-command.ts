import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { LocalLlmConnectionResult } from '../../providers/built-in/local-llm.js';
import { config as localLlmConfig } from '../../providers/built-in/local-llm.js';

const PROVIDER_ID = localLlmConfig.id;

type CmdResult = { stdout: string; stderr: string; exitCode: number };

function helpText(): string {
  return `local-llm — inspect and configure the Local LLM provider

Usage:
  local-llm                Show current config + verify connection
  local-llm status         Same as no args
  local-llm discover       Probe the server and save discovered model IDs
  local-llm --help         Show this help message

The provider connects to any OpenAI-compatible local server (Ollama,
LM Studio, llama.cpp, vLLM, mlx_lm.server, Jan, LocalAI). Configure the
base URL in Settings → Providers → Local LLM, then run \`local-llm
discover\` to populate the model list automatically.

Common base URLs:
  Ollama       http://localhost:11434/v1
  LM Studio    http://localhost:1234/v1
  llama.cpp    http://localhost:8080/v1
  vLLM         http://localhost:8000/v1
  Jan          http://localhost:1337/v1
`;
}

function runtimeLabel(runtime: LocalLlmConnectionResult['runtime'], paren: boolean): string {
  if (!runtime.version) return runtime.kind;
  return paren ? `${runtime.kind} (${runtime.version})` : `${runtime.kind} ${runtime.version}`;
}

function modelBulletLines(models: string[]): string[] {
  return models.map((m) => `    • ${m}`);
}

function unreachableResult(baseUrl: string, result: LocalLlmConnectionResult): CmdResult {
  const lines = [
    `✗ Could not reach ${baseUrl}`,
    `  runtime: ${runtimeLabel(result.runtime, true)}`,
    `  error:   ${result.error?.message ?? 'unknown'}`,
  ];
  if (result.error?.hint) lines.push(`  hint:    ${result.error.hint}`);
  return { stdout: '', stderr: lines.join('\n') + '\n', exitCode: 1 };
}

function statusResult(baseUrl: string, result: LocalLlmConnectionResult): CmdResult {
  const lines = [
    `✓ ${baseUrl}`,
    `  runtime: ${runtimeLabel(result.runtime, true)}`,
    `  models:  ${result.models.length}`,
    ...modelBulletLines(result.models),
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

function discoverSavedResult(baseUrl: string, result: LocalLlmConnectionResult): CmdResult {
  const n = result.models.length;
  const lines = [
    `✓ ${baseUrl} (${runtimeLabel(result.runtime, false)})`,
    `  Saved ${n} model${n === 1 ? '' : 's'} to Settings:`,
    ...modelBulletLines(result.models),
  ];
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

export function createLocalLlmCommand(): Command {
  return defineCommand(PROVIDER_ID, async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    const { getApiKeyForProvider, getRawApiKeyForProvider, getBaseUrlForProvider, addAccount } =
      await import('../../providers/account-store.js');
    const { verifyConnection } = await import('../../providers/built-in/local-llm.js');

    const sub = args[0] ?? 'status';
    if (sub !== 'status' && sub !== 'discover') {
      return {
        stdout: '',
        stderr: `Unknown subcommand: ${sub}. See \`local-llm --help\`.\n`,
        exitCode: 2,
      };
    }

    const baseUrl = getBaseUrlForProvider(PROVIDER_ID);
    if (!baseUrl) {
      return {
        stdout: '',
        stderr:
          'Local LLM is not configured. Open Settings → Providers → Local LLM and set a base URL.\n',
        exitCode: 1,
      };
    }
    const apiKey = getApiKeyForProvider(PROVIDER_ID) ?? undefined;

    const result = await verifyConnection(baseUrl, apiKey);

    if (!result.ok) return unreachableResult(baseUrl, result);

    if (sub === 'discover') {
      const rawKey = getRawApiKeyForProvider(PROVIDER_ID) ?? '';
      addAccount(PROVIDER_ID, rawKey, baseUrl, result.models.join(', '));
      return discoverSavedResult(baseUrl, result);
    }

    return statusResult(baseUrl, result);
  });
}
