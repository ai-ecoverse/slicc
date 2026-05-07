/**
 * `local-llm` — inspect and configure the Local LLM (OpenAI-compatible) provider.
 *
 * Wraps the runtime fingerprint + /v1/models discovery exported by
 * `providers/built-in/local-llm.ts`. Without this command those helpers
 * would be unwired scaffolding; with it the cone (or the user) can:
 *
 *   local-llm                — show config + connection status
 *   local-llm status         — same as no args
 *   local-llm discover       — probe the server and write discovered model IDs into Settings
 *
 * Why a shell command instead of a dialog button: SLICC's Settings dialog
 * is shared by every provider and adding per-provider buttons grows that
 * surface fast. The shell is the agent-native surface — the cone can run
 * `local-llm discover` for the user when the model list is empty, and the
 * user can run it themselves from the terminal.
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { config as localLlmConfig } from '../../providers/built-in/local-llm.js';

// Single source of truth: the provider config owns the ID, the command
// reads it. Keeps the two files from drifting if the ID is ever renamed.
const PROVIDER_ID = localLlmConfig.id;

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

export function createLocalLlmCommand(): Command {
  return defineCommand(PROVIDER_ID, async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    // Lazy imports — same pattern as other supplemental commands that
    // reach into the browser settings layer.
    const { getApiKeyForProvider, getRawApiKeyForProvider, getBaseUrlForProvider, addAccount } =
      await import('../../ui/provider-settings.js');
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

    if (!result.ok) {
      const lines = [
        `✗ Could not reach ${baseUrl}`,
        `  runtime: ${result.runtime.kind}${result.runtime.version ? ` (${result.runtime.version})` : ''}`,
        `  error:   ${result.error?.message ?? 'unknown'}`,
      ];
      if (result.error?.hint) lines.push(`  hint:    ${result.error.hint}`);
      return { stdout: '', stderr: lines.join('\n') + '\n', exitCode: 1 };
    }

    if (sub === 'discover') {
      // Upsert the deployment field with the freshly discovered list.
      // addAccount upserts by providerId; pass the *raw* stored key so we
      // never durably persist the optionalApiKey placeholder ('local').
      // If we passed `apiKey` here, the placeholder would round-trip into
      // localStorage and become a real stored value — confusing the next
      // edit in Settings and shadowing the optionalApiKey fallback path.
      const rawKey = getRawApiKeyForProvider(PROVIDER_ID) ?? '';
      addAccount(PROVIDER_ID, rawKey, baseUrl, result.models.join(', '));
      const lines = [
        `✓ ${baseUrl} (${result.runtime.kind}${result.runtime.version ? ` ${result.runtime.version}` : ''})`,
        `  Saved ${result.models.length} model${result.models.length === 1 ? '' : 's'} to Settings:`,
        ...result.models.map((m) => `    • ${m}`),
      ];
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
    }

    // status
    const lines = [
      `✓ ${baseUrl}`,
      `  runtime: ${result.runtime.kind}${result.runtime.version ? ` (${result.runtime.version})` : ''}`,
      `  models:  ${result.models.length}`,
      ...result.models.map((m) => `    • ${m}`),
    ];
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  });
}
