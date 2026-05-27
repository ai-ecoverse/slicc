// /auth/cloud-callback — IMS implicit-grant popup landing page.
//
// Security model: CSP is strict (`script-src 'self'`) — no inline JS — so the
// token-bearing page never executes attacker-controlled markup. The popup
// extracts the access_token from location.hash, postMessages it to the opener
// (the dashboard), then closes itself.

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body>Signing in… you can close this tab if it doesn't close automatically.
<script src="/auth/cloud-callback.js"></script>
</body></html>`;

const CALLBACK_JS = `(function () {
  var hash = window.location.hash.replace(/^#/, '');
  var params = new URLSearchParams(hash);
  var token = params.get('access_token');
  var expiresIn = params.get('expires_in');
  if (!window.opener) {
    document.body.textContent = 'Sign-in completed, but no opener — close this tab.';
    return;
  }
  if (token) {
    window.opener.postMessage(
      { type: 'sliccy.cloud.imsToken', token: token, expiresIn: expiresIn },
      window.location.origin
    );
  } else {
    window.opener.postMessage(
      { type: 'sliccy.cloud.imsError', error: hash || 'no access_token in URL' },
      window.location.origin
    );
  }
  window.close();
})();`;

export function handleCloudCallback(): Response {
  return new Response(HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none';",
    },
  });
}

export function handleCloudCallbackScript(): Response {
  return new Response(CALLBACK_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
