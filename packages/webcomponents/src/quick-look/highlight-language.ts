/**
 * Plain-text fallback for languages the shipped Shiki bundle cannot load.
 *
 * `@pierre/diffs` infers a grammar from the FILE NAME against its own table of
 * ~230 extensions, then asks Shiki's `bundledLanguages` for it. The webapp
 * build swaps that map for a curated subset (`packages/webapp/src/shims/
 * shiki-bundle.ts`), so a perfectly ordinary file — `.abap`, `.cs`, `.h`,
 * `.conf` — infers a grammar the bundle does not have. The library does not
 * degrade then: `resolveLanguage` throws "not found", the highlighter never
 * initializes, and the view renders NOTHING (a diff) or only what an earlier
 * render happened to leave behind.
 *
 * So every SLICC surface that hands a file to `@pierre/diffs` passes it through
 * `withPlainTextFallback` first: when each grammar the render needs resolves,
 * the input goes through untouched and highlights as before; when one does
 * not, every target is forced to `lang: 'text'`, which the library renders as
 * the ordinary unhighlighted view without consulting Shiki's map at all.
 *
 * Membership is probed with the library's own `resolveLanguage` rather than a
 * copied list, so the guard always agrees with whatever `shiki/langs` resolves
 * to in the build at hand (curated in the webapp, complete in Storybook) and
 * never drifts from it. Probing loads the one grammar the render would load
 * anyway, into the same cache, so it adds no fetch. A grammar chunk that fails
 * to load falls back the same way.
 *
 * Beside Quick Look rather than in `internal/` for the reason `mime-label.ts`
 * gives, and DOM-free with only a type import of `@pierre/diffs`, so neither
 * caller pays for the library before it chooses to load it: Quick Look imports
 * it lazily and passes the module in; the webapp's `<slicc-diff>` reaches this
 * through the `@slicc/webcomponents/quick-look/highlight-language` entry.
 */

import type { SupportedLanguages } from '@pierre/diffs';

/** The two `@pierre/diffs` functions the guard needs — pass the module itself. */
export type DiffsLanguageApi = Pick<
  typeof import('@pierre/diffs'),
  'getFiletypeFromFileName' | 'resolveLanguage'
>;

/**
 * What `@pierre/diffs` infers grammars from. Structurally a `FileContents`
 * (two-file diffs, single files) or a `FileDiffMetadata` (parsed patches),
 * so callers pass their own objects.
 */
export interface HighlightTarget {
  name: string;
  /** Pre-rename path of a parsed patch; its grammar is inferred separately. */
  prevName?: string;
  /** An explicit grammar wins over inference, so it is the one checked. */
  lang?: SupportedLanguages;
}

/** True for the languages `@pierre/diffs` renders without any grammar. */
function isGrammarless(lang: SupportedLanguages): lang is 'text' | 'ansi' {
  return lang === 'text' || lang === 'ansi';
}

/** Every grammar `@pierre/diffs` would request for one target. */
function languagesOf(diffs: DiffsLanguageApi, target: HighlightTarget): SupportedLanguages[] {
  if (target.lang != null) return [target.lang];
  const names = target.prevName != null ? [target.prevName, target.name] : [target.name];
  return names.map((name) => diffs.getFiletypeFromFileName(name));
}

/** True when the bundle can load `lang` (or it needs no grammar). */
async function canLoad(diffs: DiffsLanguageApi, lang: SupportedLanguages): Promise<boolean> {
  if (isGrammarless(lang)) return true;
  try {
    await diffs.resolveLanguage(lang);
    return true;
  } catch {
    return false;
  }
}

/**
 * `targets` ready to hand to `@pierre/diffs`: the same objects when every
 * grammar they need resolves, otherwise copies forced to `lang: 'text'`.
 *
 * All-or-nothing on purpose. A two-file diff is ONE render whose language
 * comes from the new side's `lang` (falling back to inferring both names), so
 * fixing one side alone would still request the missing grammar.
 */
export async function withPlainTextFallback<T extends HighlightTarget>(
  diffs: DiffsLanguageApi,
  targets: readonly T[]
): Promise<Array<T & Pick<HighlightTarget, 'lang'>>> {
  const needed = new Set(targets.flatMap((target) => languagesOf(diffs, target)));
  const loadable = await Promise.all([...needed].map((lang) => canLoad(diffs, lang)));
  if (loadable.every(Boolean)) return [...targets];
  return targets.map((target) => ({ ...target, lang: 'text' as const }));
}
