import TOKENS_CSS from './tokens.css?raw';

/** Raw token stylesheet text (light `:root` + dark scopes). */
export { TOKENS_CSS };

export type SliccTheme = 'light' | 'dark';

/** Scoop/context accent hues, keyed by the prototype's `data-k` values. */
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

/**
 * Inject the token stylesheet into a document once (idempotent). Components do
 * not need this — custom properties inherit through shadow boundaries — but a
 * host page / test harness calls it so `var(--canvas)` etc. resolve.
 */
export function ensureGlobalTokens(doc: Document = document): void {
  if (doc.getElementById(TOKENS_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = TOKENS_STYLE_ID;
  style.textContent = TOKENS_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Apply a theme to a scope element (defaults to `<body>`). */
export function setTheme(theme: SliccTheme, scope: HTMLElement = document.body): void {
  scope.classList.toggle('dark', theme === 'dark');
  scope.setAttribute('data-theme', theme);
}

/** Resolve the active theme for a scope element (defaults to `<body>`). */
export function getTheme(scope: HTMLElement = document.body): SliccTheme {
  if (scope.classList.contains('dark') || scope.getAttribute('data-theme') === 'dark') {
    return 'dark';
  }
  return 'light';
}
