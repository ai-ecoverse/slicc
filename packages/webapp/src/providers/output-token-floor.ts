import { isBedrockCampClaudeModel } from './built-in/bedrock-camp-compat.js';

interface OutputTokenModel {
  api: string;
  id: string;
  name?: string;
}

interface OutputTokenFloorRule {
  apis: readonly string[];
  applies: (model: OutputTokenModel) => boolean;
  min: number;
}

const RULES: readonly OutputTokenFloorRule[] = [
  {
    apis: ['bedrock-camp-converse', 'bedrock-converse-stream'],
    applies: (model) => !isBedrockCampClaudeModel(model),
    min: 16,
  },
];

export function minOutputTokens(model: OutputTokenModel): number {
  let min = 1;
  for (const rule of RULES) {
    if (rule.apis.includes(model.api) && rule.applies(model)) min = Math.max(min, rule.min);
  }
  return min;
}

export function withOutputTokenFloor(
  model: OutputTokenModel,
  maxTokens: number | undefined
): number | undefined {
  return maxTokens === undefined ? undefined : Math.max(maxTokens, minOutputTokens(model));
}
