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
