import type { ToolProgressEvent } from '@slicc/shared-ts';

export type ProgressEvent = ToolProgressEvent;
export type { ToolProgressEvent };

export type ProgressSink = (e: ProgressEvent) => void;

export const PROGRESS_CONTENT_TYPE = 'progress' as const;

export interface ProgressContent {
  type: typeof PROGRESS_CONTENT_TYPE;
  progress: ProgressEvent;
}
