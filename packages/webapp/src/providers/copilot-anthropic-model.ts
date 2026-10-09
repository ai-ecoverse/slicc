import type { AnthropicMessagesCompat, Api, Model } from '@earendil-works/pi-ai';
import { withoutNativeAnthropicMidConvoCompat } from './anthropic-proxy-compat.js';

/** GitHub Copilot's Anthropic gateway does not support native mid-convo features. */
export function copilotAnthropicModel(
  model: Model<Api>,
  resolved: { baseUrl: string; headers: Record<string, string> }
): Model<'anthropic-messages'> {
  return {
    ...model,
    api: 'anthropic-messages',
    baseUrl: resolved.baseUrl,
    headers: resolved.headers,
    provider: 'github-copilot',
    compat: withoutNativeAnthropicMidConvoCompat(
      model.compat as AnthropicMessagesCompat | undefined
    ),
  };
}
