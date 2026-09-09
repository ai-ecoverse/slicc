/** Shared receiver for parent-sanitized theme updates in sprinkles and dips. */
export const iframeThemeBridgeSource = `
  var _themeOverrideKeys = [];
  var _themeCssStyle = null;
  function applyIframeTheme(event) {
    if (event.source !== parent) return;
    var msg = event.data;
    document.documentElement.classList.toggle('theme-light', !!msg.isLight);
    var rootStyle = document.documentElement.style;
    _themeOverrideKeys.forEach(function(key) { rootStyle.removeProperty(key); });
    _themeOverrideKeys = [];
    Object.entries(msg.overrides || {}).forEach(function(entry) {
      if (entry[0].startsWith('--') && typeof entry[1] === 'string') {
        rootStyle.setProperty(entry[0], entry[1]);
        _themeOverrideKeys.push(entry[0]);
      }
    });
    if (typeof msg.css === 'string' && msg.css) {
      if (!_themeCssStyle) {
        _themeCssStyle = document.createElement('style');
        _themeCssStyle.id = 'slicc-iframe-theme-overrides';
        document.head.appendChild(_themeCssStyle);
      }
      _themeCssStyle.textContent = msg.css;
    } else if (_themeCssStyle) {
      _themeCssStyle.remove();
      _themeCssStyle = null;
    }
  }
`;
