/**
 * SLICC Backbone — shared module for EDS playground sprinkles.
 * Provides DA content I/O, GitHub code I/O, AEM preview/publish,
 * cross-playground navigation, and Spectrum 2 UI helpers.
 *
 * Loaded via <script src="/shared/backbone.js"></script> inside preview SW.
 * All fetch calls route through /api/fetch-proxy in CLI mode or direct in extension mode.
 */
var BB = {
  // Site config
  site: { org: '', repo: '', ref: 'main', sitePath: '', daClientId: '', daClientSecret: '', daServiceToken: '', githubToken: '' },

  // Caches
  _queryIndex: null,
  _daToken: null,
  _configLoaded: false,

  // ── Extension detection ─────────────────────────────────────────
  get isExtension() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  },

  // ── Fetch helper (handles CLI proxy vs extension direct) ────────
  _fetch: function(url, opts) {
    if (this.isExtension) {
      return fetch(url, opts);
    }
    // CLI mode: route through SLICC's fetch proxy
    var headers = Object.assign({}, (opts && opts.headers) || {});
    headers['X-Target-URL'] = url;
    var proxyOpts = Object.assign({}, opts || {}, { headers: headers, cache: 'no-store' });
    // For FormData bodies, don't set content-type (browser sets boundary)
    if (opts && opts.body instanceof FormData) {
      delete proxyOpts.headers['Content-Type'];
    }
    return fetch('/api/fetch-proxy', proxyOpts);
  },

  // ── Init ────────────────────────────────────────────────────────
  init: function(config) {
    if (config) {
      Object.assign(this.site, config);
      this._configLoaded = true;
    }
    return this;
  },

  // ── IMS Token Exchange ──────────────────────────────────────────
  getDAToken: function() {
    var self = this;
    if (self._daToken && Date.now() < self._daToken.expiresAt - 300000) {
      return Promise.resolve(self._daToken.token);
    }
    var params = 'grant_type=authorization_code' +
      '&client_id=' + encodeURIComponent(self.site.daClientId) +
      '&client_secret=' + encodeURIComponent(self.site.daClientSecret) +
      '&code=' + encodeURIComponent(self.site.daServiceToken);

    return self._fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    }).then(function(res) {
      if (!res.ok) throw new Error('IMS token exchange failed: ' + res.status);
      return res.json();
    }).then(function(data) {
      self._daToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 82800) * 1000
      };
      return self._daToken.token;
    });
  },

  // ── DA Content I/O ──────────────────────────────────────────────
  _daPath: function(pagePath) {
    var p = pagePath.replace(/^\//, '').replace(/\.html$/, '');
    if (p.endsWith('/')) p += 'index';
    return p + '.html';
  },

  getPage: function(pagePath) {
    var self = this;
    var path = self._daPath(pagePath);
    return self.getDAToken().then(function(token) {
      var url = 'https://admin.da.live/source/' + self.site.org + '/' + self.site.repo + '/' + path;
      return self._fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    }).then(function(res) {
      if (!res.ok) throw new Error('DA GET failed: ' + res.status);
      return res.text();
    });
  },

  putPage: function(pagePath, html) {
    var self = this;
    var path = self._daPath(pagePath);
    return self.getDAToken().then(function(token) {
      var formData = new FormData();
      formData.append('data', new Blob([html], { type: 'text/html' }), 'index.html');
      var url = 'https://admin.da.live/source/' + self.site.org + '/' + self.site.repo + '/' + path;
      return self._fetch(url, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
    }).then(function(res) {
      if (!res.ok) throw new Error('DA PUT failed: ' + res.status);
      return res.json();
    });
  },

  listPages: function(dirPath) {
    var self = this;
    var path = (dirPath || '').replace(/^\//, '').replace(/\/$/, '');
    return self.getDAToken().then(function(token) {
      var url = 'https://admin.da.live/list/' + self.site.org + '/' + self.site.repo + '/' + path;
      return self._fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    }).then(function(res) {
      if (!res.ok) throw new Error('DA LIST failed: ' + res.status);
      return res.json();
    });
  },

  uploadMedia: function(mediaPath, blob) {
    var self = this;
    var path = mediaPath.replace(/^\//, '');
    return self.getDAToken().then(function(token) {
      var formData = new FormData();
      formData.append('data', blob, path.split('/').pop());
      var url = 'https://admin.da.live/source/' + self.site.org + '/' + self.site.repo + '/' + path;
      return self._fetch(url, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token },
        body: formData
      });
    }).then(function(res) {
      if (!res.ok) throw new Error('DA media upload failed: ' + res.status);
      return res.json();
    });
  },

  // ── AEM Preview / Publish ───────────────────────────────────────
  previewPage: function(pagePath) {
    var self = this;
    var path = pagePath.replace(/^\//, '').replace(/\.html$/, '');
    return self.getDAToken().then(function(token) {
      var url = 'https://admin.hlx.page/preview/' + self.site.org + '/' + self.site.repo + '/' + self.site.ref + '/' + path;
      return self._fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    }).then(function(res) {
      if (!res.ok) throw new Error('Preview failed: ' + res.status);
      return res.json();
    });
  },

  publishPage: function(pagePath) {
    var self = this;
    var path = pagePath.replace(/^\//, '').replace(/\.html$/, '');
    return self.getDAToken().then(function(token) {
      var url = 'https://admin.hlx.page/live/' + self.site.org + '/' + self.site.repo + '/' + self.site.ref + '/' + path;
      return self._fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    }).then(function(res) {
      if (!res.ok) throw new Error('Publish failed: ' + res.status);
      return res.json();
    });
  },

  // ── AEM Page Fetch ──────────────────────────────────────────────
  _aemBase: function() {
    return 'https://' + this.site.ref + '--' + this.site.repo + '--' + this.site.org + '.aem.page';
  },

  getAEMPage: function(pagePath) {
    var self = this;
    var path = pagePath.replace(/^\//, '');
    return self._fetch(self._aemBase() + '/' + path).then(function(res) {
      if (!res.ok && !path.endsWith('/')) {
        return self._fetch(self._aemBase() + '/' + path + '/');
      }
      return res;
    }).then(function(res) {
      if (!res.ok) throw new Error('AEM fetch failed: ' + res.status);
      return res.text();
    });
  },

  getAEMPlainHTML: function(pagePath) {
    var self = this;
    var path = pagePath.replace(/^\//, '').replace(/\/$/, '');
    return self._fetch(self._aemBase() + '/' + path + '.plain.html').then(function(res) {
      if (!res.ok && res.status === 404) {
        return self._fetch(self._aemBase() + '/' + path + '/index.plain.html');
      }
      return res;
    }).then(function(res) {
      if (!res.ok) throw new Error('AEM plain.html failed: ' + res.status);
      return res.text();
    });
  },

  getAEMCSS: function(cssPath) {
    var self = this;
    var path = cssPath.replace(/^\//, '');
    return self._fetch(self._aemBase() + '/' + path).then(function(res) {
      if (!res.ok) return '';
      return res.text();
    });
  },

  // ── Query Index ─────────────────────────────────────────────────
  getQueryIndex: function() {
    var self = this;
    if (self._queryIndex) return Promise.resolve(self._queryIndex);
    var url = self._aemBase() + self.site.sitePath + '/query-index.json';
    return self._fetch(url).then(function(res) {
      if (!res.ok) return [];
      return res.json();
    }).then(function(data) {
      self._queryIndex = data.data || data;
      return self._queryIndex;
    });
  },

  // ── GitHub Code I/O ─────────────────────────────────────────────
  _ghHeaders: function() {
    return {
      Authorization: 'Bearer ' + this.site.githubToken,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'slicc'
    };
  },

  _ghFetch: function(path, opts) {
    var url = path.startsWith('https://') ? path : 'https://api.github.com' + path;
    var headers = Object.assign(this._ghHeaders(), (opts && opts.headers) || {});
    return this._fetch(url, Object.assign({}, opts || {}, { headers: headers }));
  },

  getFile: function(filePath) {
    var self = this;
    var ref = self.site.ref || 'main';
    return self._ghFetch('/repos/' + self.site.org + '/' + self.site.repo + '/contents/' + filePath + '?ref=' + ref)
      .then(function(res) {
        if (!res.ok) throw new Error('GitHub GET failed: ' + res.status);
        return res.json();
      }).then(function(data) {
        if (data.encoding === 'base64') {
          return atob(data.content.replace(/\n/g, ''));
        }
        return JSON.stringify(data);
      });
  },

  getTree: function() {
    var self = this;
    var ref = self.site.ref || 'main';
    return self._ghFetch('/repos/' + self.site.org + '/' + self.site.repo + '/git/refs/heads/' + ref)
      .then(function(res) {
        if (!res.ok) throw new Error('GitHub ref failed: ' + res.status);
        return res.json();
      }).then(function(refData) {
        return self._ghFetch('/repos/' + self.site.org + '/' + self.site.repo + '/git/commits/' + refData.object.sha);
      }).then(function(res) { return res.json(); })
      .then(function(commitData) {
        return self._ghFetch('/repos/' + self.site.org + '/' + self.site.repo + '/git/trees/' + commitData.tree.sha + '?recursive=1');
      }).then(function(res) { return res.json(); })
      .then(function(treeData) {
        return treeData.tree
          .filter(function(e) { return e.type === 'blob' && !e.path.split('/').some(function(s) { return s.startsWith('.'); }); })
          .map(function(e) { return { path: e.path, sha: e.sha, size: e.size || 0 }; });
      });
  },

  commitFiles: function(files, message, branch) {
    var self = this;
    var ref = branch || self.site.ref || 'main';
    var owner = self.site.org;
    var repo = self.site.repo;
    var currentSha, baseTree;

    return self._ghFetch('/repos/' + owner + '/' + repo + '/git/refs/heads/' + ref)
      .then(function(res) {
        if (!res.ok) throw new Error('Branch ' + ref + ' not found');
        return res.json();
      }).then(function(refData) {
        currentSha = refData.object.sha;
        return self._ghFetch('/repos/' + owner + '/' + repo + '/git/commits/' + currentSha);
      }).then(function(res) { return res.json(); })
      .then(function(commitData) {
        baseTree = commitData.tree.sha;
        return Promise.all(files.map(function(f) {
          return self._ghFetch('/repos/' + owner + '/' + repo + '/git/blobs', {
            method: 'POST', body: JSON.stringify({ content: f.content, encoding: 'utf-8' })
          }).then(function(res) { return res.json(); })
            .then(function(blobData) {
              return { path: f.path, mode: '100644', type: 'blob', sha: blobData.sha };
            });
        }));
      }).then(function(treeItems) {
        return self._ghFetch('/repos/' + owner + '/' + repo + '/git/trees', {
          method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: treeItems })
        });
      }).then(function(res) { return res.json(); })
      .then(function(treeData) {
        return self._ghFetch('/repos/' + owner + '/' + repo + '/git/commits', {
          method: 'POST', body: JSON.stringify({ message: message, tree: treeData.sha, parents: [currentSha] })
        });
      }).then(function(res) { return res.json(); })
      .then(function(newCommit) {
        return self._ghFetch('/repos/' + owner + '/' + repo + '/git/refs/heads/' + ref, {
          method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false })
        }).then(function() {
          return { sha: newCommit.sha, url: 'https://github.com/' + owner + '/' + repo + '/commit/' + newCommit.sha };
        });
      });
  },

  ensureBranch: function(branchName, from) {
    var self = this;
    var owner = self.site.org;
    var repo = self.site.repo;
    var source = from || 'main';

    return self._ghFetch('/repos/' + owner + '/' + repo + '/git/refs/heads/' + branchName)
      .then(function(res) {
        if (res.ok) return { exists: true };
        return self._ghFetch('/repos/' + owner + '/' + repo + '/git/refs/heads/' + source)
          .then(function(srcRes) {
            if (!srcRes.ok) throw new Error('Source branch ' + source + ' not found');
            return srcRes.json();
          }).then(function(srcData) {
            return self._ghFetch('/repos/' + owner + '/' + repo + '/git/refs', {
              method: 'POST',
              body: JSON.stringify({ ref: 'refs/heads/' + branchName, sha: srcData.object.sha })
            });
          }).then(function(createRes) {
            if (!createRes.ok) throw new Error('Branch creation failed: ' + createRes.status);
            return { created: true };
          });
      });
  },

  // ── Preview URLs ────────────────────────────────────────────────
  previewUrl: function(pagePath) {
    var clean = pagePath ? '/' + pagePath.replace(/^\//, '').replace(/\.html$/, '') : '';
    return 'https://' + this.site.ref + '--' + this.site.repo + '--' + this.site.org + '.aem.page' + clean;
  },

  liveUrl: function(pagePath) {
    var clean = pagePath ? '/' + pagePath.replace(/^\//, '').replace(/\.html$/, '') : '';
    return 'https://' + this.site.ref + '--' + this.site.repo + '--' + this.site.org + '.aem.live' + clean;
  },

  // ── Cross-Playground Navigation ─────────────────────────────────
  open: function(playground, context) {
    var params = new URLSearchParams(context || {});
    var qs = params.toString();
    var url = '/shared/' + playground + '.html' + (qs ? '?' + qs : '');
    // Use preview SW path
    if (typeof slicc !== 'undefined') {
      slicc.lick({ action: 'open-playground', data: { url: url } });
    } else {
      window.location.href = '/preview' + url;
    }
  },

  getContext: function() {
    var params = new URLSearchParams(window.location.search);
    var ctx = {};
    for (var pair of params) ctx[pair[0]] = pair[1];
    return ctx;
  },

  // ── UI Helpers ──────────────────────────────────────────────────
  statusBar: function(el) {
    var bar = typeof el === 'string' ? document.querySelector(el) : el;
    return {
      set: function(text, type) {
        type = type || 'info';
        bar.textContent = text;
        bar.className = 'status-bar status-' + type;
      },
      saving: function() { this.set('Saving\u2026', 'info'); },
      saved: function() { var s = this; s.set('Saved', 'success'); setTimeout(function() { s.set('Ready'); }, 2000); },
      error: function(msg) { this.set(msg, 'error'); }
    };
  },

  pushButton: function(el, getHtml, pagePath) {
    var self = this;
    var btn = typeof el === 'string' ? document.querySelector(el) : el;
    btn.addEventListener('click', function() {
      btn.disabled = true;
      btn.textContent = 'Pushing\u2026';
      var html = typeof getHtml === 'function' ? getHtml() : getHtml;
      self.putPage(pagePath, html).then(function() {
        return self.previewPage(pagePath);
      }).then(function() {
        btn.textContent = 'Pushed \u2713';
        setTimeout(function() { btn.textContent = 'Push to DA'; btn.disabled = false; }, 2000);
      }).catch(function(e) {
        btn.textContent = 'Failed';
        console.error(e);
        setTimeout(function() { btn.textContent = 'Push to DA'; btn.disabled = false; }, 3000);
      });
    });
  },

  // ── Diff Modal ──────────────────────────────────────────────────
  showDiff: function(before, after) {
    var overlay = document.createElement('div');
    overlay.className = 'bb-diff-overlay';
    overlay.innerHTML =
      '<div class="bb-diff-modal">' +
        '<div class="bb-diff-header">' +
          '<span>Changes</span>' +
          '<button class="bb-diff-close">&times;</button>' +
        '</div>' +
        '<div class="bb-diff-body">' +
          '<div class="bb-diff-pane"><h4>Before</h4><pre>' + BB.escapeHtml(before) + '</pre></div>' +
          '<div class="bb-diff-pane"><h4>After</h4><pre>' + BB.escapeHtml(after) + '</pre></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.bb-diff-close').onclick = function() { overlay.remove(); };
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  },

  escapeHtml: function(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // ── Shared Spectrum 2 CSS ───────────────────────────────────────
  get spectrum2CSS() {
    return ':root {' +
      '--s2-gray-25: #FAFAFA; --s2-gray-50: #F5F5F5; --s2-gray-75: #EEEEEE;' +
      '--s2-gray-100: #E1E1E1; --s2-gray-200: #CACACA; --s2-gray-300: #B3B3B3;' +
      '--s2-gray-400: #8F8F8F; --s2-gray-500: #6E6E6E; --s2-gray-600: #4B4B4B;' +
      '--s2-gray-700: #2C2C2C; --s2-gray-800: #1A1A1A; --s2-gray-900: #0F0F0F;' +
      '--s2-blue-400: #378EF0; --s2-blue-500: #2680EB; --s2-blue-600: #1473E6;' +
      '--s2-blue-700: #0D66D0; --s2-green-400: #33AB84; --s2-green-600: #12805C;' +
      '--s2-red-400: #EC5B62; --s2-red-600: #D7373F;' +
      '--s2-orange-400: #F29423; --s2-yellow-400: #EDCC00;' +
      '--s2-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '--s2-font-mono: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;' +
      '--s2-radius-s: 4px; --s2-radius-m: 8px; --s2-radius-l: 12px; --s2-radius-xl: 16px;' +
      '--s2-radius-pill: 9999px;' +
      '--s2-spacing-50: 2px; --s2-spacing-75: 4px; --s2-spacing-100: 8px;' +
      '--s2-spacing-200: 12px; --s2-spacing-300: 16px; --s2-spacing-400: 24px;' +
      '--s2-spacing-500: 32px; --s2-spacing-600: 40px;' +
      '--s2-shadow-100: 0 1px 4px rgba(0,0,0,0.08);' +
      '--s2-shadow-200: 0 2px 8px rgba(0,0,0,0.12);' +
      '--s2-shadow-300: 0 4px 16px rgba(0,0,0,0.16);' +
    '}' +
    '*, *::before, *::after { box-sizing: border-box; }' +
    'body { margin: 0; font-family: var(--s2-font-sans); background: var(--s2-gray-50);' +
      'color: var(--s2-gray-800); -webkit-font-smoothing: antialiased; }' +
    '.bb-header { height: 48px; background: var(--s2-gray-900); display: flex;' +
      'align-items: center; padding: 0 var(--s2-spacing-400); gap: var(--s2-spacing-300);' +
      'color: white; font-size: 13px; font-weight: 500; position: sticky; top: 0; z-index: 100; }' +
    '.bb-header a { color: var(--s2-gray-300); text-decoration: none; font-size: 12px; }' +
    '.bb-header a:hover { color: white; }' +
    '.bb-header .logo { font-weight: 700; font-size: 14px; letter-spacing: -0.3px; }' +
    '.bb-header .sep { color: var(--s2-gray-600); }' +
    '.s2-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px;' +
      'padding: 0 14px; border-radius: var(--s2-radius-pill); border: none;' +
      'font: 500 13px var(--s2-font-sans); cursor: pointer; transition: all 0.15s ease;' +
      'text-decoration: none; white-space: nowrap; }' +
    '.s2-btn-primary { background: var(--s2-blue-600); color: white; }' +
    '.s2-btn-primary:hover { background: var(--s2-blue-700); }' +
    '.s2-btn-primary:disabled { background: var(--s2-gray-300); cursor: not-allowed; }' +
    '.s2-btn-secondary { background: var(--s2-gray-75); color: var(--s2-gray-800); border: 1px solid var(--s2-gray-200); }' +
    '.s2-btn-secondary:hover { background: var(--s2-gray-100); }' +
    '.s2-btn-danger { background: var(--s2-red-600); color: white; }' +
    '.s2-btn-danger:hover { background: #c42f37; }' +
    '.s2-btn-success { background: var(--s2-green-600); color: white; }' +
    '.s2-btn-success:hover { background: #0e6d4e; }' +
    '.s2-btn-ghost { background: transparent; color: var(--s2-gray-600); }' +
    '.s2-btn-ghost:hover { background: var(--s2-gray-75); color: var(--s2-gray-800); }' +
    '.s2-btn-sm { height: 28px; padding: 0 10px; font-size: 12px; }' +
    '.s2-card { background: white; border-radius: var(--s2-radius-l); border: 1px solid var(--s2-gray-100);' +
      'box-shadow: var(--s2-shadow-100); overflow: hidden; }' +
    '.s2-input { height: 32px; padding: 0 10px; border: 1px solid var(--s2-gray-200);' +
      'border-radius: var(--s2-radius-m); font: 13px var(--s2-font-sans);' +
      'background: white; color: var(--s2-gray-800); outline: none; transition: border-color 0.15s; }' +
    '.s2-input:focus { border-color: var(--s2-blue-500); }' +
    '.s2-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px;' +
      'border-radius: var(--s2-radius-pill); font-size: 11px; font-weight: 600; }' +
    '.s2-badge-info { background: #E5F0FF; color: var(--s2-blue-700); }' +
    '.s2-badge-success { background: #E0F5EC; color: var(--s2-green-600); }' +
    '.s2-badge-warning { background: #FFF3E0; color: #B86E00; }' +
    '.s2-badge-danger { background: #FFE5E6; color: var(--s2-red-600); }' +
    '.status-bar { padding: 6px 16px; font-size: 12px; font-family: var(--s2-font-mono);' +
      'border-top: 1px solid var(--s2-gray-100); background: white; }' +
    '.status-info { color: var(--s2-gray-500); }' +
    '.status-success { color: var(--s2-green-600); }' +
    '.status-error { color: var(--s2-red-600); }' +
    '.bb-diff-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;' +
      'display: flex; align-items: center; justify-content: center; }' +
    '.bb-diff-modal { background: white; border-radius: var(--s2-radius-l); width: 90vw; max-height: 80vh;' +
      'display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--s2-shadow-300); }' +
    '.bb-diff-header { padding: 12px 16px; display: flex; justify-content: space-between;' +
      'align-items: center; border-bottom: 1px solid var(--s2-gray-100); font-weight: 600; }' +
    '.bb-diff-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--s2-gray-500); }' +
    '.bb-diff-body { display: grid; grid-template-columns: 1fr 1fr; flex: 1; overflow: auto; }' +
    '.bb-diff-pane { padding: 16px; overflow: auto; }' +
    '.bb-diff-pane h4 { margin: 0 0 8px; font-size: 12px; color: var(--s2-gray-500); text-transform: uppercase; }' +
    '.bb-diff-pane pre { font: 12px/1.5 var(--s2-font-mono); white-space: pre-wrap; margin: 0; }' +
    '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }';
  },

  // ── Header HTML ─────────────────────────────────────────────────
  headerHTML: function(title) {
    return '<div class="bb-header">' +
      '<a href="/preview/shared/hub.html" class="logo">SLICC</a>' +
      '<span class="sep">/</span>' +
      '<span>' + title + '</span>' +
      '<div style="flex:1"></div>' +
      '<a href="/preview/shared/hub.html">Hub</a>' +
      '<a href="/preview/shared/page-browser.html">Pages</a>' +
      '<a href="/preview/shared/wysiwyg-editor.html">Editor</a>' +
      '<a href="/preview/shared/seo-audit.html">SEO</a>' +
      '<a href="/preview/shared/accessibility-audit.html">A11y</a>' +
      '<a href="/preview/shared/content-audit.html">Content</a>' +
      '<a href="/preview/shared/code-editor.html">Code</a>' +
      '<a href="/preview/shared/publish-manager.html">Publish</a>' +
    '</div>';
  },

  // ── Inject CSS + Header ─────────────────────────────────────────
  injectStyles: function() {
    if (document.getElementById('bb-spectrum2-css')) return;
    var style = document.createElement('style');
    style.id = 'bb-spectrum2-css';
    style.textContent = this.spectrum2CSS;
    document.head.appendChild(style);
  },

  injectHeader: function(title) {
    this.injectStyles();
    var header = document.createElement('div');
    header.innerHTML = this.headerHTML(title);
    document.body.insertBefore(header.firstChild, document.body.firstChild);
  }
};

if (typeof module !== 'undefined') module.exports = BB;
