/**
 * Direct DA upload — bypasses migration-backend-worker.
 * Handles image hashing, URL rewriting, DA upload, and preview trigger.
 *
 * Usage (in slicc JavaScript tool):
 *   const result = await daUpload({
 *     projectPath: '/shared/vibemigrated',
 *     sourceUrl: 'https://www.astrazeneca.com/',
 *     org: 'aemcoder',
 *     site: 'vibemigrated',
 *     daToken: 'Bearer ...',
 *     pageTitle: 'AstraZeneca Homepage',
 *   });
 *
 * Requires: JSZip available globally or via import.
 */
async function daUpload(options) {
  var projectPath = options.projectPath;
  var sourceUrl = options.sourceUrl || '';
  var org = options.org;
  var site = options.site;
  var daToken = options.daToken;
  var pageTitle = options.pageTitle || 'Migrated Page';

  // Generate 8-char hex migration ID
  var idBytes = crypto.getRandomValues(new Uint8Array(4));
  var migrationId = Array.from(idBytes).map(function(b) {
    return b.toString(16).padStart(2, '0');
  }).join('');

  var DA_BASE = 'https://admin.da.live/source/' + org + '/' + site;
  var PREVIEW_BASE = 'https://admin.hlx.page/preview/' + org + '/' + site + '/main';

  var results = {
    migrationId: migrationId,
    imagesUploaded: 0,
    imagesDeduped: 0,
    htmlUploaded: [],
    previewUrls: {},
    errors: [],
  };

  // --- Read HTML content ---
  var mainHtml = await fs.readFile(projectPath + '/drafts/index.plain.html', { encoding: 'utf-8' });
  var navHtml = '';
  var footerHtml = '';
  try { navHtml = await fs.readFile(projectPath + '/drafts/nav.plain.html', { encoding: 'utf-8' }); } catch(e) {}
  try { footerHtml = await fs.readFile(projectPath + '/drafts/footer.plain.html', { encoding: 'utf-8' }); } catch(e) {}

  // --- Append metadata block to main HTML (DA pipeline converts to meta tags) ---
  var metadataBlock = '\n<div>\n  <div class="metadata">\n' +
    '    <div><div>nav</div><div>/' + migrationId + '/nav</div></div>\n' +
    '    <div><div>footer</div><div>/' + migrationId + '/footer</div></div>\n' +
    '    <div><div>title</div><div>' + pageTitle + '</div></div>\n' +
    '  </div>\n</div>';
  mainHtml = mainHtml + metadataBlock;

  // --- Rewrite image paths for DA ---
  function fixImagePaths(html) {
    return html.replace(/\/drafts\/images\//g, './images/');
  }
  mainHtml = fixImagePaths(mainHtml);
  navHtml = fixImagePaths(navHtml);
  footerHtml = fixImagePaths(footerHtml);

  // --- Wrap HTML for DA ---
  function wrapHtml(html) {
    if (/<html/i.test(html)) return html;
    return '<html><body><main>' + html + '</main></body></html>';
  }

  // --- Upload helper ---
  async function uploadToDa(path, blob, filename) {
    var url = DA_BASE + '/' + path;
    var formData = new FormData();
    formData.append('data', blob, filename);
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': daToken },
      body: formData,
    });
    if (!resp.ok) {
      var errText = await resp.text().catch(function() { return ''; });
      throw new Error('DA upload failed (' + resp.status + '): ' + path + ' - ' + errText);
    }
    return resp;
  }

  // --- Hash image content (SHA-256 → 16-char hex) ---
  async function hashImage(data) {
    var hashBuffer = await crypto.subtle.digest('SHA-256', data);
    var hashHex = Array.from(new Uint8Array(hashBuffer)).map(function(b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
    return hashHex.slice(0, 16);
  }

  // --- Get file extension ---
  function getExt(filename) {
    var parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'bin';
  }

  // --- MIME type from extension ---
  function getMime(ext) {
    var map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      avif: 'image/avif', ico: 'image/x-icon',
    };
    return map[ext] || 'application/octet-stream';
  }

  // --- Upload images with deduplication ---
  var imageMapping = {};
  var uploadedHashes = {};

  try {
    var imageDir = projectPath + '/drafts/images';
    var imageEntries = await fs.readDir(imageDir);

    for (var i = 0; i < imageEntries.length; i++) {
      var entry = imageEntries[i];
      var name = typeof entry === 'string' ? entry : entry.name;
      if (name.startsWith('.')) continue;

      try {
        var data = await fs.readFileBinary(imageDir + '/' + name);
        var hash16 = await hashImage(data);
        var ext = getExt(name);
        var hashedFilename = hash16 + '.' + ext;
        var absoluteUrl = 'https://content.da.live/' + org + '/' + site + '/' + migrationId + '/images/' + hashedFilename;

        imageMapping[name] = absoluteUrl;

        if (!uploadedHashes[hash16]) {
          var imagePath = migrationId + '/images/' + hashedFilename;
          var blob = new Blob([data], { type: getMime(ext) });
          await uploadToDa(imagePath, blob, hashedFilename);
          uploadedHashes[hash16] = true;
          results.imagesUploaded++;
        } else {
          results.imagesDeduped++;
        }
      } catch (imgErr) {
        results.errors.push('Image ' + name + ': ' + (imgErr.message || imgErr));
      }
    }
  } catch (e) {
    results.errors.push('Image directory read failed: ' + (e.message || e));
  }

  // --- Rewrite image URLs in HTML ---
  function rewriteImageUrls(html) {
    var keys = Object.keys(imageMapping);
    for (var k = 0; k < keys.length; k++) {
      var originalName = keys[k];
      var absoluteUrl = imageMapping[originalName];
      var escaped = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp('\\.\/images\/' + escaped, 'g'), absoluteUrl);
      html = html.replace(new RegExp("(?<=['\"`(=])images\\/" + escaped, 'g'), absoluteUrl);
      html = html.replace(new RegExp("(?<=['\"`(=])\\/images\\/" + escaped, 'g'), absoluteUrl);
    }
    return html;
  }

  mainHtml = rewriteImageUrls(mainHtml);
  navHtml = rewriteImageUrls(navHtml);
  footerHtml = rewriteImageUrls(footerHtml);

  // --- Upload HTML ---
  try {
    var mainBlob = new Blob([wrapHtml(mainHtml)], { type: 'text/html' });
    await uploadToDa(migrationId + '/index.html', mainBlob, 'index.html');
    results.htmlUploaded.push('index');
  } catch (e) {
    results.errors.push('Main HTML: ' + (e.message || e));
  }

  if (navHtml) {
    try {
      var navBlob = new Blob([wrapHtml(navHtml)], { type: 'text/html' });
      await uploadToDa(migrationId + '/nav.html', navBlob, 'nav.html');
      results.htmlUploaded.push('nav');
    } catch (e) {
      results.errors.push('Nav HTML: ' + (e.message || e));
    }
  }

  if (footerHtml) {
    try {
      var footerBlob = new Blob([wrapHtml(footerHtml)], { type: 'text/html' });
      await uploadToDa(migrationId + '/footer.html', footerBlob, 'footer.html');
      results.htmlUploaded.push('footer');
    } catch (e) {
      results.errors.push('Footer HTML: ' + (e.message || e));
    }
  }

  // --- Trigger preview (best-effort) ---
  async function triggerPreview(path) {
    var cleanPath = path.replace(/\.html$/, '');
    var url = PREVIEW_BASE + '/' + cleanPath;
    try {
      var resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': daToken,
          'x-content-source-authorization': daToken,
          'Content-Length': '0',
        },
      });
      return resp.ok;
    } catch (e) {
      return false;
    }
  }

  var previewBase = 'https://' + migrationId + '--' + site + '--' + org + '.aem.page/' + migrationId;

  if (results.htmlUploaded.includes('index')) {
    await triggerPreview(migrationId + '/index.html');
    results.previewUrls.main = previewBase + '/';
  }
  if (results.htmlUploaded.includes('nav')) {
    await triggerPreview(migrationId + '/nav.html');
    results.previewUrls.nav = previewBase + '/nav/';
  }
  if (results.htmlUploaded.includes('footer')) {
    await triggerPreview(migrationId + '/footer.html');
    results.previewUrls.footer = previewBase + '/footer/';
  }

  results.daContentUrl = 'https://da.live/#/' + org + '/' + site + '/' + migrationId;

  return results;
}

if (typeof module !== 'undefined') module.exports = { daUpload };
