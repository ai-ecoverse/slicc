import type { AnthropicMessagesCompat } from '@earendil-works/pi-ai';

/**
 * Clear native Anthropic mid-conversation capability flags for proxy transports.
 *
 * Catalog Claude models may set `supportsMidConvoEffort` (and system/tool mid-convo
 * flags). Those describe Anthropic's first-party API; Bedrock / GitHub Copilot
 * gateways reject message-level `output_config` and do not accept mid-convo
 * system/tool folds the same way. Override after catalog discovery so pi-ai keeps
 * effort and tools at request level.
 */
export function withoutNativeAnthropicMidConvoCompat(
  compat: AnthropicMessagesCompat | undefined
): AnthropicMessagesCompat {
  return {
    ...compat,
    supportsMidConvoEffort: false,
    supportsMidConvoSystemMessages: false,
    supportsMidConvoToolChanges: false,
  };
}
