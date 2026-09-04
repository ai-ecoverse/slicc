/**
 * Iframe repaint-nudge workaround — moved to @slicc/shared-ts (#2276 slice E
 * round-1 review) so the extension can import it without a webapp-owned
 * copy drifting out of sync. Re-exported here so no webapp-internal import
 * path changes.
 */
export { isNestedInAnotherFrame, nudgeIframeRepaint } from '@slicc/shared-ts';
