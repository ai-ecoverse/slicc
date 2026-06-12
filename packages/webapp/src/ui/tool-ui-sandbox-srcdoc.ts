/**
 * Standalone srcdoc equivalent of chrome-extension/tool-ui-sandbox.html.
 * Keep in sync with that file when updating the sandbox script.
 */
export const TOOL_UI_SANDBOX_SRCDOC = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: auto; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .sprinkle-action-card { padding: 12px; border-radius: 8px; }
  .sprinkle-action-card__header { margin-bottom: 8px; font-weight: 500; }
  .sprinkle-action-card__actions { display: flex; gap: 8px; }
  .sprinkle-btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  .sprinkle-btn--primary { background: var(--accent, #3b82f6); color: white; }
  .sprinkle-btn--secondary { background: #2a2a2a; color: #e0e0e0; }
  .sprinkle-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
  .sprinkle-badge--notice { background: #f59e0b22; color: #f59e0b; }
</style>
<script>
window.__toolui_id = '';
window.__toolui_nonce = '';
window.__parentOrigin = '*';

function sendToParent(message) {
  message.nonce = window.__toolui_nonce;
  parent.postMessage(message, window.__parentOrigin);
}

document.addEventListener('click', function(e) {
  var target = e.target;
  while (target && target !== document.body) {
    if (target.dataset && target.dataset.action) {
      var action = target.dataset.action;
      var data = target.dataset.actionData;
      try { data = data ? JSON.parse(data) : undefined; } catch(err) { /* keep as string */ }
      var picker = target.dataset.picker || undefined;
      sendToParent({ type: 'tool-ui-action', id: window.__toolui_id, action: action, data: data, picker: picker });
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    target = target.parentElement;
  }
});

addEventListener('message', function(e) {
  if (e.source !== parent) return;
  var msg = e.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'tool-ui-render') {
    window.__toolui_id = msg.id || '';
    window.__toolui_nonce = msg.nonce || '';
    window.__parentOrigin = e.origin || '*';
    var temp = document.createElement('div');
    temp.innerHTML = msg.html;
    var scripts = temp.querySelectorAll('script');
    for (var i = scripts.length - 1; i >= 0; i--) scripts[i].parentNode.removeChild(scripts[i]);
    document.body.innerHTML = temp.innerHTML;
    requestAnimationFrame(function() {
      sendToParent({ type: 'tool-ui-rendered', id: window.__toolui_id, height: document.documentElement.scrollHeight });
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function() {
        sendToParent({ type: 'tool-ui-resize', id: window.__toolui_id, height: document.documentElement.scrollHeight });
      }).observe(document.body);
    }
  }
  if (msg.type === 'slicc-theme') {
    document.documentElement.classList.toggle('theme-light', !!msg.isLight);
  }
});
</script>
</head>
<body></body>
</html>`;
