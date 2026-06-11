/**
 * Legacy alias for `<slicc-press-button>` — the implementation lives in
 * `@slicc/webcomponents` (it was lifted into the library verbatim, then
 * gained the squish/wobble press animations and self-injected chrome). This
 * shim keeps the legacy import path alive for `layout.ts` / `chat-panel.ts` /
 * `rail-zone.ts` until the WC shell replaces them; importing it registers
 * the element. The legacy ripple tint is restored via the `--press-ripple`
 * override in `styles/tabs.css`.
 */
export {
  DEFAULT_DOUBLE_CLICK_MS,
  SliccPressButton,
} from '@slicc/webcomponents/src/primitives/slicc-press-button.js';
