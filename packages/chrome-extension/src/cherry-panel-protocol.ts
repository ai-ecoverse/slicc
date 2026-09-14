import type { CherryFeatures } from '@ai-ecoverse/cherry';

export const CHERRY_PANEL_PORT_NAME = 'cherry-panel';

export interface PanelHelloMessage {
  kind: 'hello';
}

export interface PanelFocusLeaderMessage {
  kind: 'focus-leader';

  openSettings?: boolean;
}
export type PanelToSwMessage = PanelHelloMessage | PanelFocusLeaderMessage;

export type SwToPanelMessage =
  | { kind: 'join-url'; state: 'booting' }
  | { kind: 'join-url'; state: 'ready'; joinUrl: string }
  | { kind: 'join-url'; state: 'disconnected' };

export const SIDE_PANEL_FEATURES: CherryFeatures = {
  terminal: false,
  files: false,
  memory: false,
  browser: false,
  monitor: false,
  modelPicker: false,
  history: true,
  nav: true,
};
