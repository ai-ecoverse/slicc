import type { AnthropicMessagesCompat } from '@earendil-works/pi-ai';

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
