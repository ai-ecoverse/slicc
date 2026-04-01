/**
 * Google Gemini — Gemini models via Google's OpenAI-compatible endpoint.
 *
 * Uses the existing streamOpenAICompletions from pi-ai with a fixed base URL
 * pointing to Google's OpenAI-compatible API. No native Google SDK needed.
 */

import { registerApiProvider } from '@mariozechner/pi-ai';
import type { Api } from '@mariozechner/pi-ai';
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from '@mariozechner/pi-ai/dist/providers/openai-completions.js';
import type { ProviderConfig } from '../types.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

const GEMINI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: 'max_completion_tokens' as const,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: true,
  supportsStrictMode: false,
};

export const config: ProviderConfig = {
  id: 'google-gemini',
  name: 'Google Gemini',
  description: 'Gemini models via Google AI (OpenAI-compatible)',
  requiresApiKey: true,
  apiKeyPlaceholder: 'Google AI API key',
  apiKeyEnvVar: 'GOOGLE_AI_API_KEY',
  requiresBaseUrl: false,
  getModelIds: () => [
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      api: 'openai' as const,
      context_window: 1_048_576,
      max_tokens: 65_536,
      reasoning: true,
      input: ['text', 'image'],
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      api: 'openai' as const,
      context_window: 1_048_576,
      max_tokens: 65_536,
      reasoning: true,
      input: ['text', 'image'],
    },
  ],
};

export function register(): void {
  registerApiProvider({
    api: 'google-gemini-openai' as Api,
    stream: (model, context, options) =>
      streamOpenAICompletions(
        {
          ...model,
          api: 'openai-completions' as Api,
          baseUrl: GEMINI_BASE_URL,
          compat: GEMINI_COMPAT,
        } as Parameters<typeof streamOpenAICompletions>[0],
        context,
        options
      ),
    streamSimple: (model, context, options) =>
      streamSimpleOpenAICompletions(
        {
          ...model,
          api: 'openai-completions' as Api,
          baseUrl: GEMINI_BASE_URL,
          compat: GEMINI_COMPAT,
        } as Parameters<typeof streamSimpleOpenAICompletions>[0],
        context,
        options
      ),
  });
}
