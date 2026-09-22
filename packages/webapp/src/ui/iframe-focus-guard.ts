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
