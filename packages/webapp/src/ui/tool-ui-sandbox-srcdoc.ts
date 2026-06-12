/**
 * Standalone srcdoc equivalent of chrome-extension/tool-ui-sandbox.html.
 * Keep in sync with that file when updating the sandbox script.
 */
export const TOOL_UI_SANDBOX_SRCDOC = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: auto; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: transparent;
    color: var(--s2-gray-900, #e8e8e8);
  }
  .sprinkle-action-card {
    display: flex; flex-direction: column;
    background: var(--s2-gray-25, #1e1e1e);
    border: 1px solid var(--s2-gray-200, #383838);
    border-radius: var(--s2-radius-xl, 16px);
    overflow: hidden;
    box-shadow: var(--s2-shadow-container, 0 2px 8px rgba(0,0,0,.35));
  }
  .sprinkle-action-card__header {
    display: flex; align-items: center; gap: 12px;
    padding: 16px 20px 12px;
    font-weight: 700; font-size: 14px; line-height: 1.3;
    color: var(--s2-gray-900, #e8e8e8);
  }
  .sprinkle-action-card__path {
    padding: 0 20px 12px;
    font-size: 13px;
    color: var(--s2-gray-600, #aaa);
  }
  .sprinkle-action-card__path code {
    font-family: var(--s2-font-family-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--s2-gray-900, #e8e8e8);
    background: var(--s2-gray-100, #383838);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .sprinkle-action-card__actions { display: flex; gap: 8px; padding: 0 20px 16px; justify-content: flex-end; }
  .sprinkle-btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 32px; padding: 0 16px;
    border: 1px solid var(--s2-gray-200, #484848);
    border-radius: 16px;
    background: var(--s2-gray-50, #2c2c2c);
    color: var(--s2-gray-900, #e8e8e8);
    font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer;
    transition: background .15s;
  }
  .sprinkle-btn:hover { background: var(--s2-gray-100, #383838); }
  .sprinkle-btn--primary {
    background: var(--s2-accent, #3b82f6); color: #fff;
    border-color: transparent; border-radius: 999px;
  }
  .sprinkle-btn--primary:hover { background: var(--s2-accent-hover, #2563eb); }
  .sprinkle-btn--secondary {
    background: var(--s2-gray-50, #2c2c2c);
    border-color: var(--s2-gray-200, #484848);
    color: var(--s2-gray-900, #e8e8e8);
  }
  .sprinkle-badge {
    display: inline-flex; align-items: center;
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 8px;
    margin-left: auto;
  }
  .sprinkle-badge--notice { background: rgba(245,158,11,.15); color: #f59e0b; }
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
