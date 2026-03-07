/**
 * Self-contained synchronous IIFE that extracts brand data from the
 * current page DOM. Designed to run in-page via CDP `evaluate()`.
 * No imports — everything is inlined.
 *
 * Returns JSON matching the BrandData interface:
 * { fonts, colors, spacing, favicons }
 */
export const BRAND_EXTRACT_SCRIPT = `(function() {
  var HEADING_SIZE_MAP = {
    H1: 'xxl', H2: 'xl', H3: 'l',
    H4: 'm', H5: 's', H6: 'xs'
  };

  var DEFAULT_MOBILE_SIZES = {
    xxl: '36px', xl: '28px', l: '24px',
    m: '20px', s: '18px', xs: '16px'
  };

  function parsePrimaryFont(familySet) {
    var first = (familySet.split(',')[0] || '').trim();
    return first.replace(/^["']|["']$/g, '');
  }

  function extractFontInfo(el) {
    var style = window.getComputedStyle(el);
    var familySet = style.fontFamily || '';
    return {
      family: parsePrimaryFont(familySet),
      familySet: familySet
    };
  }

  function extractHeadingSizes() {
    var sizes = {};
    var tiers = ['xxl', 'xl', 'l', 'm', 's', 'xs'];
    for (var i = 0; i < tiers.length; i++) {
      sizes[tiers[i]] = {
        mobile: DEFAULT_MOBILE_SIZES[tiers[i]],
        desktop: ''
      };
    }
    var tags = Object.keys(HEADING_SIZE_MAP);
    for (var j = 0; j < tags.length; j++) {
      var tag = tags[j];
      var tier = HEADING_SIZE_MAP[tag];
      var el = document.querySelector(tag.toLowerCase());
      if (el) {
        sizes[tier].desktop = window.getComputedStyle(el).fontSize;
      }
    }
    return sizes;
  }

  function extractBodyFont() {
    var mainP = document.querySelector('main p');
    if (mainP) return extractFontInfo(mainP);
    var firstP = document.querySelector('p');
    if (firstP) return extractFontInfo(firstP);
    return extractFontInfo(document.body);
  }

  function extractHeadingFont() {
    var heading = document.querySelector('h1, h2, h3');
    if (heading) return extractFontInfo(heading);
    return { family: '', familySet: '' };
  }

  function extractBaseColors() {
    var style = window.getComputedStyle(document.body);
    return {
      background: style.backgroundColor || '',
      text: style.color || ''
    };
  }

  function extractLinkColor() {
    var link = document.querySelector('main a') ||
               document.querySelector('a');
    if (!link) return '';
    return window.getComputedStyle(link).color || '';
  }

  function extractLinkHoverColor() {
    try {
      var sheets = document.styleSheets;
      for (var i = 0; i < sheets.length; i++) {
        var rules;
        try { rules = sheets[i].cssRules; } catch(e) { continue; }
        for (var j = 0; j < rules.length; j++) {
          var rule = rules[j];
          if (rule.selectorText) {
            var selectors = rule.selectorText.split(',');
            for (var k = 0; k < selectors.length; k++) {
              if (/^a:hover$/i.test(selectors[k].trim())) {
                var color = rule.style.color;
                if (color) return color;
              }
            }
          }
        }
      }
    } catch(e) {}
    return null;
  }

  function parseRgb(color) {
    var match = color.match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
    if (!match) return null;
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10)
    };
  }

  function luminance(rgb) {
    return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  }

  function extractLightDarkColors() {
    var sections = document.querySelectorAll('section');
    var lightestColor = '';
    var lightestLum = 255;
    var darkestColor = '';
    var darkestLum = Infinity;

    for (var i = 0; i < sections.length; i++) {
      var bg = window.getComputedStyle(sections[i]).backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;

      var rgb = parseRgb(bg);
      if (!rgb) continue;

      var lum = luminance(rgb);

      if (lum < 254 && (lightestColor === '' || lum > lightestLum)) {
        lightestLum = lum;
        lightestColor = bg;
      }

      if (darkestColor === '' || lum < darkestLum) {
        darkestLum = lum;
        darkestColor = bg;
      }
    }

    return { light: lightestColor, dark: darkestColor };
  }

  function extractSectionPadding() {
    var section = document.querySelector('section') ||
                  document.querySelector('main');
    if (!section) return '';
    return window.getComputedStyle(section).paddingTop || '';
  }

  function extractContentMaxWidth() {
    var selectors = [
      'main > .container',
      'main > .wrapper',
      'main > [class*="container"]',
      'main > [class*="wrapper"]',
      'main > div',
      '.container',
      '.wrapper',
      '[class*="container"]',
      '[class*="wrapper"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (!el) continue;
      var mw = window.getComputedStyle(el).maxWidth;
      if (mw && mw !== 'none' && mw !== '0px') return mw;
    }
    return '';
  }

  function extractNavHeight() {
    var el = document.querySelector('nav') ||
             document.querySelector('header');
    if (!el) return '';
    return window.getComputedStyle(el).height || '';
  }

  function extractFavicons() {
    var links = document.querySelectorAll('link[rel*="icon"]');
    var seen = {};
    var favicons = [];

    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href');
      if (!href) continue;

      var url = new URL(href, window.location.href).href;
      if (seen[url]) continue;
      seen[url] = true;

      var entry = {
        url: url,
        rel: link.getAttribute('rel') || 'icon'
      };

      var sizes = link.getAttribute('sizes');
      if (sizes) entry.sizes = sizes;

      var type = link.getAttribute('type');
      if (type) entry.type = type;

      favicons.push(entry);
    }

    if (favicons.length === 0) {
      favicons.push({
        url: new URL('/favicon.ico', window.location.href).href,
        rel: 'icon'
      });
    }

    return favicons;
  }

  function detectFontSources() {
    var sources = { typekit: null, googleFonts: [] };
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var tkMatch = href.match(/use\\.typekit\\.net\\/([a-z0-9]+)\\.css/);
      if (tkMatch) {
        sources.typekit = tkMatch[1];
      }
      if (href.indexOf('fonts.googleapis.com') !== -1) {
        sources.googleFonts.push(href);
      }
    }
    return sources;
  }

  var bodyFont = extractBodyFont();
  var headingFont = extractHeadingFont();
  var headingSizes = extractHeadingSizes();
  var baseColors = extractBaseColors();
  var linkColor = extractLinkColor();
  var linkHover = extractLinkHoverColor();
  var lightDark = extractLightDarkColors();
  var fontSources = detectFontSources();

  return {
    fonts: {
      body: bodyFont,
      heading: headingFont,
      headingSizes: headingSizes,
      sources: fontSources
    },
    colors: {
      background: baseColors.background,
      text: baseColors.text,
      link: linkColor,
      linkHover: linkHover,
      light: lightDark.light,
      dark: lightDark.dark
    },
    spacing: {
      sectionPadding: extractSectionPadding(),
      contentMaxWidth: extractContentMaxWidth(),
      navHeight: extractNavHeight()
    },
    favicons: extractFavicons()
  };
})()`;
