import type { AnthropicMessagesCompat, Api, Model } from '@earendil-works/pi-ai';

export function adobeAnthropicModel(
  model: Model<Api>,
  endpoint: string
): Model<'anthropic-messages'> {
  return {
    ...model,
    baseUrl: endpoint,
    api: 'anthropic-messages',
    compat: {
      ...(model.compat as AnthropicMessagesCompat | undefined),
      supportsMidConvoEffort: false,
      supportsMidConvoSystemMessages: false,
      supportsMidConvoToolChanges: false,
    },
  };
}
