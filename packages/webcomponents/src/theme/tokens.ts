import TOKENS_CSS from './tokens.css?raw';

export { TOKENS_CSS };

export type SliccTheme = 'light' | 'dark';

export const SCOOP_HUES = {
  cone: 'var(--waffle)',
  researcher: 'var(--cyan)',
  designer: 'var(--violet)',
  tester: 'var(--amber)',
  triage: 'var(--green)',
  scoop: 'var(--rose)',
} as const;

export type ScoopKind = keyof typeof SCOOP_HUES;

const TOKENS_STYLE_ID = 'slicc-tokens';

export function ensureGlobalTokens(doc: Document = document): void {
  if (doc.getElementById(TOKENS_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = TOKENS_STYLE_ID;
  style.textContent = TOKENS_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function setTheme(theme: SliccTheme, scope: HTMLElement = document.body): void {
  scope.classList.toggle('dark', theme === 'dark');
  scope.setAttribute('data-theme', theme);
}

export function getTheme(scope: HTMLElement = document.body): SliccTheme {
  if (scope.classList.contains('dark') || scope.getAttribute('data-theme') === 'dark') {
    return 'dark';
  }
  return 'light';
}

export function followSystemTheme(scope: HTMLElement = document.body): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (): void => setTheme(query.matches ? 'dark' : 'light', scope);
  apply();
  query.addEventListener('change', apply);
  return () => query.removeEventListener('change', apply);
}
