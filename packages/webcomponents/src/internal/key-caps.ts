/**
 * How a key prints on a cap — shared by every surface that draws one, so the
 * HUD strip (`<slicc-key-hud>`) and the floating hints (`<slicc-keycap>`) can
 * never name the same key two different ways.
 */

/**
 * Caps whose key is a SHAPE rather than a letter, drawn as the lucide glyph
 * instead of the character. A `⏎` typed into a font is whatever that font
 * thinks a return is — at 11px, usually a smudge; the icon is the same stroke
 * weight as every other glyph in the app, at the size we asked for.
 *
 * Modifiers (`⌘`, `⇧`, `⌥`) stay text: those characters ARE the keys' legends,
 * and every Mac keyboard prints them exactly so.
 */
export const CAP_ICONS: Readonly<Record<string, string>> = {
  '⏎': 'corner-down-left',
  '↵': 'corner-down-left',
  Enter: 'corner-down-left',
  '←': 'arrow-left',
  '→': 'arrow-right',
  '↑': 'arrow-up',
  '↓': 'arrow-down',
  '⇥': 'arrow-right-to-line',
};
