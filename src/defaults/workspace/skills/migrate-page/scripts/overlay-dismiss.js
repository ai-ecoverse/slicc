(async () => {
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var results = [];

  var KNOWN_SELECTORS = {
    onetrust: {
      banner: '#onetrust-consent-sdk, .onetrust-pc-dark-filter',
      dismiss: '#onetrust-accept-btn-handler, .onetrust-close-btn-handler'
    },
    cookiebot: {
      banner: '#CybotCookiebotDialog',
      dismiss: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll'
    },
    cookieconsent: {
      banner: '.cc-window, .cc-banner',
      dismiss: '.cc-btn.cc-dismiss, .cc-allow'
    },
    intercom: {
      banner: '#intercom-container, .intercom-lightweight-app',
      dismiss: '.intercom-launcher'
    },
    zendesk: {
      banner: '#launcher, [data-testid="launcher"]',
      dismiss: '[data-testid="launcher"]'
    },
    drift: {
      banner: '#drift-widget, .drift-frame-controller',
      dismiss: '.drift-widget-close-icon'
    },
    generic: {
      banner: '[class*="cookie"], [class*="consent"], [class*="gdpr"], [id*="cookie"], [id*="consent"]',
      dismiss: '[class*="accept"], [class*="allow"], [class*="agree"], [aria-label*="close"], [aria-label*="Close"]'
    }
  };

  // Wait for consent banners to fully render (they often load async after DOMContentLoaded)
  await sleep(1500);

  var vendors = Object.keys(KNOWN_SELECTORS);
  for (var v = 0; v < vendors.length; v++) {
    var vendor = vendors[v];
    var selectors = KNOWN_SELECTORS[vendor];
    try {
      var bannerEl = document.querySelector(selectors.banner);
      if (!bannerEl) continue;

      var isVisible = bannerEl.offsetParent !== null ||
        window.getComputedStyle(bannerEl).display !== 'none';
      if (!isVisible) continue;

      // Wait up to 2s for dismiss button to appear (OneTrust renders async)
      var dismissed = false;
      var dismissSelectors = selectors.dismiss.split(',');
      for (var attempt = 0; attempt < 4 && !dismissed; attempt++) {
        for (var d = 0; d < dismissSelectors.length; d++) {
          var sel = dismissSelectors[d].trim();
          try {
            var btn = document.querySelector(sel);
            if (btn) {
              btn.click();
              dismissed = true;
              results.push({ vendor: vendor, action: 'click', selector: sel });
              await sleep(200);
              break;
            }
          } catch (e) { /* skip selector */ }
        }
        if (!dismissed) await sleep(500);
      }

      if (!dismissed) {
        var bannerSelectors = selectors.banner.split(',');
        for (var b = 0; b < bannerSelectors.length; b++) {
          try {
            var els = document.querySelectorAll(bannerSelectors[b].trim());
            els.forEach(function(el) { el.remove(); });
            if (els.length > 0) {
              results.push({ vendor: vendor, action: 'remove', selector: bannerSelectors[b].trim(), count: els.length });
            }
          } catch (e) { /* skip */ }
        }
      }
    } catch (e) { /* skip vendor */ }
  }

  var viewportHeight = window.innerHeight;
  var viewportWidth = window.innerWidth;
  var viewportArea = viewportHeight * viewportWidth;
  var allElements = document.querySelectorAll('*');

  for (var i = 0; i < allElements.length; i++) {
    var el = allElements[i];
    var style = window.getComputedStyle(el);
    var pos = style.position;
    var zIdx = parseInt(style.zIndex) || 0;

    if ((pos === 'fixed' || pos === 'sticky') && zIdx > 100) {
      var rect = el.getBoundingClientRect();
      var area = rect.width * rect.height;
      var coverage = (area / viewportArea) * 100;

      if (coverage > 20) {
        var sel = el.tagName.toLowerCase();
        if (el.id) { sel = '#' + el.id; }
        else if (el.className && typeof el.className === 'string') {
          var cls = el.className.split(' ').filter(function(c) { return c; }).slice(0, 3);
          if (cls.length) sel += '.' + cls.join('.');
        }
        el.remove();
        results.push({
          vendor: 'fixed-overlay',
          action: 'remove',
          selector: sel,
          coverage: Math.round(coverage),
          zIndex: zIdx
        });
      }
    }
  }

  await sleep(300);

  return JSON.stringify({
    dismissed: results.length,
    results: results
  });
})()
