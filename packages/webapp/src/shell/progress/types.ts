/**
 * Progress protocol for the bash progress / ETA overlay
 * (`docs/exploration/bash-progress-overlay.md`).
 *
 * The event shape lives in `@slicc/shared-ts` as `ToolProgressEvent` because
 * it crosses the kernel → UI → tray wire as the `tool_progress` agent event
 * (and because a bare `ProgressEvent` silently resolves to the DOM global in
 * any file that forgets the import). This module re-exports it under the
 * design doc's name for the shell-side emitters and adds the sink contract.
 */

import type { ToolProgressEvent } from '@slicc/shared-ts';

export type ProgressEvent = ToolProgressEvent;
export type { ToolProgressEvent };

/** Receives every (already throttled, already scrubbed) progress event. */
export type ProgressSink = (e: ProgressEvent) => void;

/** Discriminator of the partial `AgentToolResult` content block carrying a progress event. */
export const PROGRESS_CONTENT_TYPE = 'progress' as const;

/** Partial tool-result content block emitted through `ToolExecutionContext.onUpdate`. */
export interface ProgressContent {
  type: typeof PROGRESS_CONTENT_TYPE;
  progress: ProgressEvent;
}
