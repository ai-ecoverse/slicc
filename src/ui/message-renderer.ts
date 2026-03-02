/**
 * Message renderer — converts message content to HTML with
 * syntax-highlighted code blocks and basic markdown formatting.
 */

/**
 * Simple syntax highlighter for code blocks.
 * Supports JS/TS-style keyword, string, number, comment highlighting.
 */
function highlightCode(code: string, lang: string): string {
  // Escape HTML first
  let html = escapeHtml(code);

  if (['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx'].includes(lang)) {
    html = highlightJS(html);
  } else if (['json'].includes(lang)) {
    html = highlightJSON(html);
  } else if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) {
    html = highlightBash(html);
  }

  return html;
}

function highlightJS(html: string): string {
  // Comments (// and /* */)
  html = html.replace(/(\/\/[^\n]*)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>');
  // Strings
  html = html.replace(
    /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;|`[^`]*?`)/g,
    '<span class="tok-string">$1</span>',
  );
  // Keywords
  const kw = [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'class', 'extends', 'import', 'export', 'from', 'default', 'new', 'this',
    'async', 'await', 'try', 'catch', 'throw', 'typeof', 'instanceof',
    'interface', 'type', 'enum', 'implements', 'abstract', 'public', 'private',
    'protected', 'readonly', 'static', 'void', 'null', 'undefined', 'true', 'false',
  ];
  const kwPattern = new RegExp(`\\b(${kw.join('|')})\\b`, 'g');
  html = html.replace(kwPattern, '<span class="tok-keyword">$1</span>');
  // Numbers
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
  // Function calls
  html = html.replace(/\b([a-zA-Z_$][\w$]*)\s*(?=\()/g, '<span class="tok-fn">$1</span>');

  return html;
}

function highlightJSON(html: string): string {
  html = html.replace(
    /(&quot;[^&]*?&quot;)\s*:/g,
    '<span class="tok-keyword">$1</span>:',
  );
  html = html.replace(
    /:\s*(&quot;[^&]*?&quot;)/g,
    ': <span class="tok-string">$1</span>',
  );
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
  html = html.replace(/\b(true|false|null)\b/g, '<span class="tok-keyword">$1</span>');
  return html;
}

function highlightBash(html: string): string {
  html = html.replace(/(#[^\n]*)/g, '<span class="tok-comment">$1</span>');
  html = html.replace(
    /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,
    '<span class="tok-string">$1</span>',
  );
  const kw = ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'echo', 'export', 'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'grep', 'npm', 'node', 'git'];
  const kwPattern = new RegExp(`\\b(${kw.join('|')})\\b`, 'g');
  html = html.replace(kwPattern, '<span class="tok-keyword">$1</span>');
  return html;
}

/** Escape HTML special characters. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Render a message content string to HTML.
 * Handles:
 * - Fenced code blocks with syntax highlighting
 * - Inline code
 * - Bold / italic
 * - Line breaks
 */
export function renderMessageContent(content: string): string {
  // Handle fenced code blocks
  let html = content.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const highlighted = highlightCode(code.trimEnd(), lang || 'text');
      return `<pre><code>${highlighted}</code></pre>`;
    },
  );

  // Split by <pre> blocks to avoid processing code blocks
  const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);

  html = parts
    .map((part) => {
      if (part.startsWith('<pre>')) return part;
      // Inline code
      part = part.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${escapeHtml(code)}</code>`);
      // Bold
      part = part.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Italic
      part = part.replace(/\*(.+?)\*/g, '<em>$1</em>');
      // Line breaks (double newline → paragraph break, single → <br>)
      part = part.replace(/\n\n/g, '</p><p>');
      part = part.replace(/\n/g, '<br>');
      return part;
    })
    .join('');

  return html;
}

/**
 * Render a tool call's input as a formatted string.
 */
export function renderToolInput(input: unknown): string {
  if (typeof input === 'string') return escapeHtml(input);
  try {
    return escapeHtml(JSON.stringify(input, null, 2));
  } catch {
    return escapeHtml(String(input));
  }
}
