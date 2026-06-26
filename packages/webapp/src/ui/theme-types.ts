/**
 * Theme types and token group constants for the SLICC theme personalization system.
 */

export interface ThemeComponent {
  background?: string;
  text?: string;
  border?: string;
  radius?: string;
  padding?: string;
  fontSize?: string;
  fontFamily?: string;
  shadow?: string;
  blur?: string;
  height?: string;
  opacity?: string;
}

export interface ThemeComponents {
  userBubble?: ThemeComponent;
  assistantMessage?: ThemeComponent;
  codeBlock?: ThemeComponent;
  nav?: ThemeComponent;
  composer?: ThemeComponent;
  sidebar?: ThemeComponent;
  dialog?: ThemeComponent;
}

export interface SliccTheme {
  id: string;
  name: string;
  author?: string;
  base: 'dark' | 'light';
  tokens: Record<string, string>;
  disableShader?: boolean;
  css?: string;
  components?: ThemeComponents;
}

export interface SimplifiedSlots {
  background: string;
  surface: string;
  text: string;
  accent: string;
  border: string;
  success: string;
  error: string;
}

export const TOKEN_GROUPS: Record<string, string[]> = {
  surfaces: [
    '--s2-gray-25',
    '--s2-gray-50',
    '--s2-gray-75',
    '--s2-gray-100',
    '--s2-gray-200',
    '--s2-bg-base',
    '--s2-bg-layer-1',
    '--s2-bg-layer-2',
    '--s2-bg-elevated',
    '--s2-bg-sunken',
  ],
  text: [
    '--s2-gray-800',
    '--s2-gray-900',
    '--s2-gray-1000',
    '--s2-content-default',
    '--s2-content-secondary',
    '--s2-content-tertiary',
    '--s2-content-disabled',
  ],
  accents: [
    '--slicc-cone',
    '--slicc-scoop-blue',
    '--slicc-scoop-purple',
    '--slicc-scoop-teal',
    '--slicc-accent',
    '--s2-accent',
    '--s2-accent-hover',
    '--s2-accent-down',
  ],
  semantic: ['--s2-negative', '--s2-positive', '--s2-informative', '--s2-notice'],
  chrome: [
    '--s2-border-default',
    '--s2-border-subtle',
    '--s2-border-focus',
    '--s2-shadow-elevated',
    '--s2-shadow-container',
  ],
};
