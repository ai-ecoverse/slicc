(function () {
  var ogTags = {};
  var twitterTags = {};
  var description = '';

  var metas = document.querySelectorAll('meta');
  for (var i = 0; i < metas.length; i++) {
    var meta = metas[i];
    var property = meta.getAttribute('property') || '';
    var name = meta.getAttribute('name') || '';
    var content = meta.getAttribute('content');
    if (content === null) continue;

    var key = property || name;
    if (!key) continue;

    if (property.indexOf('og:') === 0) {
      ogTags[property] = content;
    } else if (
      name.indexOf('twitter:') === 0 ||
      property.indexOf('twitter:') === 0
    ) {
      twitterTags[name || property] = content;
    }

    if (name === 'description') {
      description = content;
    }
  }

  var canonicalEl = document.querySelector('link[rel="canonical"]');
  var canonical = canonicalEl
    ? canonicalEl.getAttribute('href')
    : null;

  var jsonLd = [];
  var ldScripts = document.querySelectorAll(
    'script[type="application/ld+json"]'
  );
  for (var j = 0; j < ldScripts.length; j++) {
    try {
      jsonLd.push(JSON.parse(ldScripts[j].textContent || ''));
    } catch (e) {}
  }

  return {
    title: document.title || '',
    description: description,
    canonical: canonical,
    ogTags: ogTags,
    twitterTags: twitterTags,
    jsonLd: jsonLd
  };
})()
