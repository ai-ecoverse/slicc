import { claudeRejectsTemperature } from './claude-model-version.js';

const NON_CLAUDE_REJECTS_TEMPERATURE_RE = /gpt-5[.-]6|gpt-6-(?:sol|luna|astra)|kimi-k3(?![\d.])/;

function nonClaudeRejectsTemperature(modelId: string, modelName?: string): boolean {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.some((value) => {
    const lower = value.toLowerCase();
    return (
      NON_CLAUDE_REJECTS_TEMPERATURE_RE.test(lower) ||
      NON_CLAUDE_REJECTS_TEMPERATURE_RE.test(lower.replace(/[\s_]+/g, '-'))
    );
  });
}

export function modelSupportsTemperature(modelId: string, modelName?: string): boolean {
  if (claudeRejectsTemperature(modelId, modelName)) return false;
  return !nonClaudeRejectsTemperature(modelId, modelName);
}

export function withSupportedTemperature<T extends { temperature?: number }>(
  modelId: string,
  modelName: string | undefined,
  options: T
): T {
  if (options.temperature === undefined || modelSupportsTemperature(modelId, modelName)) {
    return options;
  }
  const { temperature: _omitted, ...rest } = options;
  return rest as T;
}
