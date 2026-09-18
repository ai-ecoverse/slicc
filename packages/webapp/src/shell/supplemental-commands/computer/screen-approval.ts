/**
 * Cone-driven screen-share approval. `getDisplayMedia` needs a user
 * gesture the worker does not have, so the card's Approve button carries
 * `data-picker="screenshare"` (not a `PickerKind` — no extension popup).
 * `dip.ts:handleDipPickerAction` runs the permissions surface on that
 * click, adopts the stream, and posts the session handle back here.
 */

import { getToolExecutionContext } from '../../../base/tool-execution-context.js';
import { showToolUI, toolUIRegistry } from '../../tool-ui.js';

/** Two minutes — enough for a slow picker, short enough to fail loud. */
const APPROVAL_TIMEOUT_MS = 120_000;

const APPROVAL_TIMEOUT_SENTINEL = Symbol('screen-share-approval-timeout');

interface ScreenShareActionData {
  cancelled?: boolean;
  error?: unknown;
  granted?: boolean;
  handle?: unknown;
}

interface ScreenShareApprovalResponse {
  approved?: boolean;
  denied?: boolean;
  cancelled?: boolean;
  error?: string;
  handle?: string;
}

export function buildScreenShareApprovalHtml(): string {
  return `
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">
        <div class="sprinkle-action-card__title-group">Share this display</div>
        <span class="sprinkle-badge sprinkle-badge--notice">approval</span>
      </div>
      <div class="sprinkle-action-card__actions">
        <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
        <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="screenshare">Share screen</button>
      </div>
    </div>
  `;
}

/**
 * Show a screen-share approval card and resolve with the page-side session
 * handle. Throws on cancellation, denial, error, or timeout.
 */
export async function runScreenShareApproval(): Promise<{ handle: string }> {
  const toolContext = getToolExecutionContext();
  if (!toolContext) {
    throw new Error(
      'add screen: needs a user gesture — type `computer add screen` in the panel terminal, or run it from a cone tool call so an approval card can open the picker'
    );
  }
  const uiRequestId = toolUIRegistry.generateId();
  let timedOut = false;

  const rawUiPromise = showToolUI(
    {
      id: uiRequestId,
      html: buildScreenShareApprovalHtml(),
      onAction: async (action, data) => {
        if (action !== 'approve') return { denied: true };
        const d = data as ScreenShareActionData | undefined;
        if (d?.cancelled) return { cancelled: true };
        if (d?.error) return { error: String(d.error) };
        if (d?.granted && typeof d.handle === 'string') {
          return { approved: true, handle: d.handle };
        }
        return { error: 'screen share returned an unexpected response' };
      },
    },
    toolContext.onUpdate
  );

  const safeUiPromise = rawUiPromise.catch((err: unknown) => {
    if (timedOut) return APPROVAL_TIMEOUT_SENTINEL;
    throw err;
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof APPROVAL_TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      toolUIRegistry.cancel(uiRequestId, 'screen share: timed out');
      resolve(APPROVAL_TIMEOUT_SENTINEL);
    }, APPROVAL_TIMEOUT_MS);
  });

  const result = await Promise.race([safeUiPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (result === APPROVAL_TIMEOUT_SENTINEL) {
    throw new Error(
      `add screen: timed out after ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s waiting for user approval`
    );
  }

  const res = result as ScreenShareApprovalResponse;
  if (res.denied) throw new Error('add screen: denied by user');
  if (res.cancelled) throw new Error('add screen: cancelled');
  if (res.error) throw new Error(`add screen: ${res.error}`);
  if (!res.approved || !res.handle) throw new Error('add screen: no display selected');
  return { handle: res.handle };
}
