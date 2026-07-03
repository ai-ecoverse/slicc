/**
 * Shared contract for the side-panel cockpit: the internal `cherry-panel` Port
 * between the sidepanel page and the service worker, and the chat-focused
 * feature set the panel mounts the follower with.
 */
import type { CherryFeatures } from '@ai-ecoverse/cherry';

/** Internal (same-extension) Port name used by the side panel. */
export const CHERRY_PANEL_PORT_NAME = 'cherry-panel';

/** Panel → SW: sent once on (re)connect so the SW can key open-state by window. */
export interface PanelHelloMessage {
  kind: 'hello';
  windowId: number;
}
export type PanelToSwMessage = PanelHelloMessage;

/** SW → panel: tri-state joinUrl status. */
export type SwToPanelMessage =
  | { kind: 'join-url'; state: 'booting' }
  | { kind: 'join-url'; state: 'ready'; joinUrl: string }
  | { kind: 'join-url'; state: 'disconnected' };

/**
 * Chat-focused sidebar: kernel-backed panels (terminal/files/memory) are inert
 * in a follower and the browser panel is redundant (the agent drives the tab via
 * real chrome.debugger CDP). `CherryFeatures` fields default to true, so hidden
 * panels must be set false explicitly.
 *
 * `modelPicker` is off: the model is chosen on the leader, so the follower's
 * composer model selector (`slicc-composer-meta`, hidden by `wc-follower` when
 * this flag is false) would be inert. This object is the single configuration
 * point — flip a flag here to change what the panel follower exposes.
 */
export const SIDE_PANEL_FEATURES: CherryFeatures = {
  terminal: false,
  files: false,
  memory: false,
  browser: false,
  newSprinkle: false,
  monitor: false,
  modelPicker: false,
  history: true,
  nav: true,
};
