/**
 * Panel types — shared type definitions for the browser-tab panel system.
 */

export type ZoneId = 'primary' | 'drawer';

export interface PanelDescriptor {
  /** Unique panel identifier (e.g. 'terminal', 'files', 'memory', 'shtml-dash'). */
  id: string;
  /** Tab display text. */
  label: string;
  /** Which zone the panel is currently in, or null if closed. */
  zone: ZoneId | null;
  /** Whether the tab shows a close button. */
  closable: boolean;
  /** The DOM element containing the panel content. */
  element: HTMLElement;
  /** Called when the tab becomes active (e.g. terminal.refit()). */
  onActivate?: () => void;
  /** Called when the panel is closed (cleanup resources). */
  onClose?: () => void;
}

export interface PanelRegistryEntry {
  descriptor: PanelDescriptor;
}
