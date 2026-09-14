import { bundledLanguages as webLanguages } from 'shiki/bundle/web';

export * from 'shiki/bundle/web';

export { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
export { createOnigurumaEngine } from 'shiki/engine/oniguruma';

const EXTRA_LANGUAGES = {
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
} as const;

export const bundledLanguages = {
  ...webLanguages,
  ...EXTRA_LANGUAGES,
} as typeof webLanguages & typeof EXTRA_LANGUAGES;
