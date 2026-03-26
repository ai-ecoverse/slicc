'use strict';
var _isStreaming = false;
var _container = document.getElementById('messages');

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
function highlightCode(code, lang) {
  var h = escapeHtml(code);
  if (['js','javascript','ts','typescript','jsx','tsx'].indexOf(lang)!==-1) return highlightJS(h);
  if (lang==='json') return highlightJSON(h);
  if (['bash','sh','shell','zsh'].indexOf(lang)!==-1) return highlightBash(h);
  return h;
}
function highlightJS(h) {
  h=h.replace(/(\/\/[^\n]*)/g,'<span class="tok-comment">$1</span>');
  h=h.replace(/(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;|`[^`]*?`)/g,'<span class="tok-string">$1</span>');
  var kw=['const','let','var','function','return','if','else','for','while','class','import','export',
    'from','async','await','new','try','catch','throw','switch','case','break','default','typeof','instanceof','of','in'];
  h=h.replace(new RegExp('\\b('+kw.join('|')+')\\b','g'),'<span class="tok-keyword">$1</span>');
  h=h.replace(/\b(\d+\.?\d*)\b/g,'<span class="tok-number">$1</span>');
  h=h.replace(/\b([a-zA-Z_$][\w$]*)\s*(?=\()/g,'<span class="tok-fn">$1</span>');
  return h;
}
function highlightJSON(h) {
  h=h.replace(/(&quot;[^&]*?&quot;)\s*:/g,'<span class="tok-keyword">$1</span>:');
  h=h.replace(/:\s*(&quot;[^&]*?&quot;)/g,': <span class="tok-string">$1</span>');
  h=h.replace(/\b(\d+\.?\d*)\b/g,'<span class="tok-number">$1</span>');
  h=h.replace(/\b(true|false|null)\b/g,'<span class="tok-keyword">$1</span>');
  return h;
}
function highlightBash(h) {
  h=h.replace(/(#[^\n]*)/g,'<span class="tok-comment">$1</span>');
  h=h.replace(/(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,'<span class="tok-string">$1</span>');
  var kw=['if','then','else','fi','for','do','done','while','case','esac','echo','export',
    'cd','ls','mkdir','rm','cp','mv','cat','grep','npm','node','git'];
  h=h.replace(new RegExp('\\b('+kw.join('|')+')\\b','g'),'<span class="tok-keyword">$1</span>');
  return h;
}
function inlineMarkdown(text) {
  var s=escapeHtml(text);
  s=s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,'<img src="$2" alt="$1">');
  s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,function(_,t,u){
    return '<a href="'+u+'" onclick="handleLink(event,\''+u.replace(/'/g,"\\'")+"')\">"+ t+'</a>';});
  s=s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/__(.+?)__/g,'<strong>$1</strong>');
  s=s.replace(/\*(.+?)\*/g,'<em>$1</em>');
  s=s.replace(/_(.+?)_/g,'<em>$1</em>');
  s=s.replace(/~~(.+?)~~/g,'<del>$1</del>');
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  return s;
}
function handleLink(event,url) {
  event.preventDefault();
  if (window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.linkHandler)
    window.webkit.messageHandlers.linkHandler.postMessage(url);
}
function renderMarkdown(text) {
  if (!text) return '';
  var lines=text.split('\n'), html='', inCode=false, codeLang='', codeLines=[];
  var inList=false, listType='';
  for (var i=0;i<lines.length;i++) {
    var line=lines[i];
    if (line.match(/^```/)) {
      if (inCode) {
        var cls=codeLang?' class="language-'+escapeHtml(codeLang)+'"':'';
        html+='<pre><code'+cls+'>'+highlightCode(codeLines.join('\n'),codeLang)+'</code></pre>\n';
        inCode=false;codeLines=[];codeLang='';
      } else {
        if(inList){html+='</'+listType+'>\n';inList=false;}
        inCode=true;codeLang=line.replace(/^```\s*/,'').trim();
      }
      continue;
    }
    if (inCode){codeLines.push(line);continue;}
    var hM=line.match(/^(#{1,6})\s+(.+)$/);
    if (hM){if(inList){html+='</'+listType+'>\n';inList=false;}
      html+='<h'+hM[1].length+'>'+inlineMarkdown(hM[2])+'</h'+hM[1].length+'>\n';continue;}
    if (line.match(/^\s*[-*+]\s+/)) {
      if(!inList||listType!=='ul'){if(inList)html+='</'+listType+'>\n';html+='<ul>\n';inList=true;listType='ul';}
      html+='<li>'+inlineMarkdown(line.replace(/^\s*[-*+]\s+/,''))+'</li>\n';continue;
    }
    var olM=line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (olM) {
      if(!inList||listType!=='ol'){if(inList)html+='</'+listType+'>\n';html+='<ol>\n';inList=true;listType='ol';}
      html+='<li>'+inlineMarkdown(olM[2])+'</li>\n';continue;
    }
    if(inList&&line.trim()===''){html+='</'+listType+'>\n';inList=false;continue;}
    if(inList&&!line.match(/^\s/)){html+='</'+listType+'>\n';inList=false;}
    if(line.match(/^>\s?/)){html+='<blockquote>'+inlineMarkdown(line.replace(/^>\s?/,''))+'</blockquote>\n';continue;}
    if(line.match(/^(---|\*\*\*|___)\s*$/)){html+='<hr>\n';continue;}
    if(line.trim()===''){html+='\n';continue;}
    html+='<p>'+inlineMarkdown(line)+'</p>\n';
  }
  if(inCode)html+='<pre><code>'+highlightCode(codeLines.join('\n'),codeLang)+'</code></pre>\n';
  if(inList)html+='</'+listType+'>\n';
  return html;
}
function renderToolCalls(tcs) {
  if(!tcs||tcs.length===0)return '';
  var html='<div class="msg__tools">';
  for(var i=0;i<tcs.length;i++){
    var tc=tcs[i],sc=tc.isError?'tool-call--error':(tc.result!=null?'tool-call--success':'');
    html+='<details class="tool-call '+sc+'"><summary><span class="tool-call__name">'+escapeHtml(tc.name)+'</span></summary>';
    html+='<div class="tool-call__body">';
    if(tc.input!=null){var is=typeof tc.input==='string'?tc.input:JSON.stringify(tc.input,null,2);
      html+='<div style="margin-bottom:4px;color:var(--content-tertiary)">Input:</div>'+escapeHtml(is);}
    if(tc.result!=null){var r=tc.result.length>2000?tc.result.substring(0,2000)+'\u2026':tc.result;
      html+='\n<div style="margin-top:6px;color:var(--content-tertiary)">Result:</div>'+escapeHtml(r);}
    html+='</div></details>';
  }
  return html+'</div>';
}

// ==========================================================================
// Bridge API — called from Swift via evaluateJavaScript
// ==========================================================================

/** Replace all messages (full snapshot). */
function loadMessages(messagesJson) {
  var messages = typeof messagesJson === 'string' ? JSON.parse(messagesJson) : messagesJson;
  _container.innerHTML = '';
  for (var i = 0; i < messages.length; i++) {
    _container.innerHTML += renderMessage(messages[i]);
  }
  scrollToBottom();
}

/** Start a new assistant message (streaming). */
function startMessage(messageId) {
  var msg = { id: messageId, role: 'assistant', content: '', isStreaming: true, toolCalls: [] };
  _container.innerHTML += renderMessage(msg);
  scrollToBottom();
}

/** Append streaming text delta to an existing message. */
function appendDelta(messageId, text) {
  var el = document.getElementById('msg-' + messageId);
  if (!el) return;
  var content = el.querySelector('.msg__content');
  if (!content) return;
  var raw = (content.getAttribute('data-raw') || '') + text;
  content.setAttribute('data-raw', raw);
  content.innerHTML = renderMarkdown(raw);
  var cursor = el.querySelector('.streaming-cursor');
  if (!cursor) {
    var c = document.createElement('span');
    c.className = 'streaming-cursor';
    el.appendChild(c);
  }
  scrollToBottom();
}

/** Mark a message as done streaming. */
function finishMessage(messageId) {
  var el = document.getElementById('msg-' + messageId);
  if (!el) return;
  var cursor = el.querySelector('.streaming-cursor');
  if (cursor) cursor.remove();
  scrollToBottom();
}

/** Add a tool call to an existing message. */
function addToolUse(messageId, toolName, toolInput) {
  var el = document.getElementById('msg-' + messageId);
  if (!el) return;
  var toolsDiv = el.querySelector('.msg__tools');
  if (!toolsDiv) {
    toolsDiv = document.createElement('div');
    toolsDiv.className = 'msg__tools';
    el.appendChild(toolsDiv);
  }
  var inputStr = typeof toolInput === 'string' ? toolInput :
    (toolInput != null ? JSON.stringify(toolInput, null, 2) : '');
  var tc = document.createElement('details');
  tc.className = 'tool-call';
  tc.innerHTML = '<summary><span class="tool-call__name">' + escapeHtml(toolName) +
    '</span></summary><div class="tool-call__body">' +
    '<div style="color:var(--content-tertiary)">Input:</div>' +
    escapeHtml(inputStr) + '</div>';
  toolsDiv.appendChild(tc);
  scrollToBottom();
}

/** Add a tool result to the last tool call in a message. */
function addToolResult(messageId, toolName, result, isError) {
  var el = document.getElementById('msg-' + messageId);
  if (!el) return;
  var tools = el.querySelectorAll('.tool-call');
  var target = tools.length > 0 ? tools[tools.length - 1] : null;
  if (!target) return;
  target.classList.add(isError ? 'tool-call--error' : 'tool-call--success');
  var body = target.querySelector('.tool-call__body');
  if (body) {
    var truncated = result && result.length > 2000 ? result.substring(0, 2000) + '\u2026' : (result || '');
    body.innerHTML += '\n<div style="margin-top:6px;color:var(--content-tertiary)">Result:</div>' +
      escapeHtml(truncated);
  }
  scrollToBottom();
}

/** Add a user message (e.g. echoed from another follower). */
function addUserMessage(text) {
  var msg = { id: 'user-' + Date.now(), role: 'user', content: text, timestamp: Date.now() };
  _container.innerHTML += renderMessage(msg);
  scrollToBottom();
}

/** Set global streaming state. */
function setStreaming(streaming) {
  _isStreaming = streaming;
  if (!streaming) {
    var cursors = document.querySelectorAll('.streaming-cursor');
    for (var i = 0; i < cursors.length; i++) cursors[i].remove();
  }
}

/** Scroll to bottom of page. */
function scrollToBottom() {
  requestAnimationFrame(function() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
}

