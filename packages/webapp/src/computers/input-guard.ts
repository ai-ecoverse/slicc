/**
 * Reject input the descriptor says it cannot accept before the backend
 * is invoked. `wait` is always allowed; everything else honors
 * `inputAllowed` plus the keyboard / mouse / scroll flags.
 */

import type { ComputerCapabilities, ComputerInputEvent } from '@slicc/shared-ts';

export function unsupportedInputReason(
  capabilities: ComputerCapabilities,
  events: ComputerInputEvent[]
): string | null {
  for (const event of events) {
    const reason = reasonForEvent(capabilities, event);
    if (reason) return reason;
  }
  return null;
}

function reasonForEvent(
  capabilities: ComputerCapabilities,
  event: ComputerInputEvent
): string | null {
  if (event.type === 'wait') return null;
  if (!capabilities.inputAllowed) return 'input is not allowed';
  if (event.type === 'key' || event.type === 'text') {
    return capabilities.keyboard ? null : 'keyboard input is not supported';
  }
  if (event.type === 'scroll') {
    return capabilities.scroll ? null : 'scroll is not supported';
  }
  if (
    event.type === 'mousemove' ||
    event.type === 'button' ||
    event.type === 'click' ||
    event.type === 'drag'
  ) {
    return capabilities.mouse === 'none' ? 'mouse input is not supported' : null;
  }
  return null;
}
