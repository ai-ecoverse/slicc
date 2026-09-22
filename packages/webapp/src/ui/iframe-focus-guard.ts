/**
 * In-frame guard against agent-authored content stealing the keyboard.
 *
 * Sprinkles and dips are same-origin srcdoc frames, and a same-origin frame
 * that calls `el.focus()` (or `window.focus()`) moves the whole page's focus
 * into itself — out of the composer, mid-sentence. They load when an AGENT
 * says so (a background scoop running `sprinkle open`/`reload`, a streamed dip),
 * so a "focus the first field on load" nicety fires while the user is typing
 * somewhere else; the keystrokes then land in the frame, and once the frame is
 * removed the shell's resting keyboard mode reads them as shortcuts.
 *
 * The rule: programmatic focus is honoured only when this frame already holds
 * the focus — moving it between the frame's own fields is the frame's
 * business, and a click anywhere in the frame (its own "next" button
 * included) gives it the focus first, because the browser does that, not the
 * frame's script. A frame nobody touched gets no say over where the keyboard
 * goes.
 *
 * Deliberately NOT `navigator.userActivation.isActive`: a keystroke in the
 * parent grants transient activation to every same-origin descendant frame
 * (HTML "activation notification"), so while the user types in the composer a
 * srcdoc frame reads as user-activated — exactly the moment a steal hurts.
 *
 * Spliced into the frame's bootstrap before any authored script runs; kept as
 * source (like `iframe-theme.ts`) because it executes inside the frame.
 */
export const iframeFocusGuardSource = `
  (function() {
    function _focusAllowed() {
      try { return document.hasFocus(); } catch (e) { return false; }
    }
    function _guardFocus(target) {
      if (!target || typeof target.focus !== 'function') return;
      var original = target.focus;
      target.focus = function() {
        if (_focusAllowed()) return original.apply(this, arguments);
      };
    }
    _guardFocus(window.HTMLElement && window.HTMLElement.prototype);
    _guardFocus(window.SVGElement && window.SVGElement.prototype);
    _guardFocus(window);
  })();
`;
