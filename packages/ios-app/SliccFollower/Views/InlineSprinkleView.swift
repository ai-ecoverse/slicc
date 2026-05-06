import SwiftUI
import WebKit

/// Renders an inline ```shtml``` code block from an assistant message as a
/// sandboxed WebView. Mirrors the lick-only minimal bridge from the web's
/// `inline-sprinkle.ts`.
///
/// - Auto-resizes height via a posted `__sliccResize` message.
/// - `lick({action, data})` from inside is forwarded via `onLick`.
struct InlineSprinkleView: UIViewRepresentable {
    /// A stable identifier so updates can target the right webview.
    let id: String
    /// Raw shtml fragment.
    let html: String
    /// Optional source/target scoop tag for the lick.
    var targetScoop: String?
    /// Lick callback wired to AppState.
    var onLick: (_ body: AnyCodable?, _ targetScoop: String?) -> Void
    /// Called when the inline content reports a new height in points.
    var onHeightChange: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: "sliccInline")

        let inject = WKUserScript(
            source: Self.bridgeJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContent.addUserScript(inject)
        config.userContentController = userContent

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.loadHTMLString(Self.wrap(html), baseURL: URL(string: "about:blank"))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastHTML != html {
            context.coordinator.lastHTML = html
            webView.loadHTMLString(Self.wrap(html), baseURL: URL(string: "about:blank"))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "sliccInline")
    }

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let parent: InlineSprinkleView
        weak var webView: WKWebView?
        var lastHTML: String = ""

        init(parent: InlineSprinkleView) { self.parent = parent }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "sliccInline",
                  let dict = message.body as? [String: Any],
                  let op = dict["op"] as? String else { return }
            switch op {
            case "lick":
                let body = dict["body"]
                let coded = body.flatMap(AnyCodable.init)
                parent.onLick(coded, parent.targetScoop)
            case "resize":
                if let h = dict["height"] as? Double, h > 0 {
                    parent.onHeightChange(CGFloat(h))
                } else if let h = dict["height"] as? Int, h > 0 {
                    parent.onHeightChange(CGFloat(h))
                }
            default: break
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Trigger an initial resize after the page loads.
            webView.evaluateJavaScript("__sliccReportHeight()", completionHandler: nil)
        }
    }

    // MARK: - HTML Wrapping

    private static func wrap(_ fragment: String) -> String {
        return """
        <!DOCTYPE html>
        <html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <style>\(sprinkleCSS)</style>
        </head><body class="sprinkle-inline">
        \(fragment)
        </body></html>
        """
    }

    /// Sprinkle component styles ported from
    /// `packages/webapp/src/ui/styles/sprinkle-components.css` and adapted
    /// for the iOS chat's dark surface. Tokens are inlined so the CSS works
    /// without the webapp's full theme variable cascade.
    private static let sprinkleCSS: String = """
    :root {
      --s-bg-base: transparent;
      --s-bg-card: #16162B;
      --s-bg-card-soft: #1F1F38;
      --s-bg-elevated: #25254A;
      --s-bg-row-hover: rgba(255,255,255,0.04);
      --s-border-subtle: rgba(255,255,255,0.06);
      --s-border-default: rgba(255,255,255,0.10);
      --s-border-strong: rgba(255,255,255,0.18);
      --s-text-primary: #F5F5FA;
      --s-text-secondary: rgba(245,245,250,0.72);
      --s-text-muted: rgba(245,245,250,0.55);
      --s-text-faint: rgba(245,245,250,0.40);
      --s-accent: #7155FA;
      --s-accent-hover: #8669FF;
      --s-accent-down: #5E45D9;
      --s-accent-soft-bg: rgba(113,85,250,0.18);
      --s-accent-soft-text: #C9BCFF;
      --s-positive: #43A356;
      --s-positive-soft-bg: rgba(67,163,86,0.18);
      --s-positive-soft-text: #93E1A4;
      --s-negative: #E0533D;
      --s-negative-soft-bg: rgba(224,83,61,0.18);
      --s-negative-soft-text: #F2A597;
      --s-notice: #E8A53D;
      --s-notice-soft-bg: rgba(232,165,61,0.20);
      --s-notice-soft-text: #F4CC85;
      --s-informative: #4DA6FF;
      --s-informative-soft-bg: rgba(77,166,255,0.18);
      --s-informative-soft-text: #A6CDFF;
      --s-radius-sm: 6px;
      --s-radius-md: 8px;
      --s-radius-lg: 12px;
      --s-radius-xl: 16px;
      --s-radius-pill: 9999px;
    }
    html, body {
      background: transparent;
      color: var(--s-text-primary);
      margin: 0;
      padding: 0;
      font: -apple-system-body;
      font-size: 15px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }
    body.sprinkle-inline {
      padding: 4px 0;
      overflow: hidden;
    }
    *, *::before, *::after { box-sizing: border-box; }
    p { margin: 0 0 8px; }
    p:last-child { margin-bottom: 0; }
    a { color: var(--s-accent-soft-text); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.92em;
      background: rgba(255,255,255,0.08);
      border-radius: 4px;
      padding: 1px 5px;
    }
    /* ── Buttons ───────────────────────────────────────────────────── */
    button, .sprinkle-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 32px;
      padding: 0 14px;
      border: 1px solid var(--s-border-strong);
      border-radius: var(--s-radius-pill);
      background: var(--s-bg-elevated);
      color: var(--s-text-primary);
      font: -apple-system-body;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: default;
      -webkit-tap-highlight-color: transparent;
      transition: background 130ms ease, border-color 130ms ease, transform 80ms ease;
    }
    button:active, .sprinkle-btn:active { transform: scale(0.97); }
    button:disabled, .sprinkle-btn:disabled { opacity: 0.4; pointer-events: none; }
    .sprinkle-btn--primary {
      background: var(--s-accent);
      border-color: transparent;
      color: #fff;
    }
    .sprinkle-btn--primary:active { background: var(--s-accent-down); }
    .sprinkle-btn--secondary {
      background: var(--s-bg-elevated);
      border-color: var(--s-border-default);
      color: var(--s-text-primary);
    }
    .sprinkle-btn--negative {
      background: var(--s-negative);
      border-color: transparent;
      color: #fff;
    }
    .sprinkle-btn--quiet {
      background: transparent;
      border-color: transparent;
      color: var(--s-text-secondary);
    }
    .sprinkle-btn-group { display: inline-flex; gap: 8px; }
    /* ── Badges ────────────────────────────────────────────────────── */
    .sprinkle-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      line-height: 16px;
      white-space: nowrap;
      background: var(--s-bg-elevated);
      color: var(--s-text-primary);
    }
    .sprinkle-badge--notice    { background: var(--s-notice-soft-bg);      color: var(--s-notice-soft-text); }
    .sprinkle-badge--positive  { background: var(--s-positive-soft-bg);    color: var(--s-positive-soft-text); }
    .sprinkle-badge--negative  { background: var(--s-negative-soft-bg);    color: var(--s-negative-soft-text); }
    .sprinkle-badge--informative,
    .sprinkle-badge--accent    { background: var(--s-accent-soft-bg);      color: var(--s-accent-soft-text); }
    .sprinkle-badge--subtle    { background: rgba(255,255,255,0.06);       color: var(--s-text-secondary); }
    .sprinkle-badge--outline {
      background: transparent;
      color: var(--s-text-secondary);
      box-shadow: inset 0 0 0 1px var(--s-border-default);
    }
    /* ── Status Lights ─────────────────────────────────────────────── */
    .sprinkle-status-light {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--s-text-secondary);
    }
    .sprinkle-status-light::before {
      content: ''; width: 8px; height: 8px; border-radius: 50%;
      background: var(--s-text-muted); flex-shrink: 0;
    }
    .sprinkle-status-light--positive::before    { background: var(--s-positive); }
    .sprinkle-status-light--negative::before    { background: var(--s-negative); }
    .sprinkle-status-light--notice::before      { background: var(--s-notice); }
    .sprinkle-status-light--informative::before { background: var(--s-informative); }
    /* ── Card ──────────────────────────────────────────────────────── */
    .sprinkle-card {
      background: var(--s-bg-card);
      border: 1px solid var(--s-border-subtle);
      border-radius: var(--s-radius-xl);
      padding: 16px;
    }
    .sprinkle-stat-card {
      background: var(--s-bg-card);
      border: 1px solid var(--s-border-subtle);
      border-radius: var(--s-radius-xl);
      padding: 12px 16px;
      text-align: center;
    }
    .sprinkle-stat-card .value {
      font-size: 24px; font-weight: 700; color: var(--s-text-primary); line-height: 1.2;
    }
    .sprinkle-stat-card .label {
      font-size: 11px; font-weight: 500; color: var(--s-text-muted); margin-top: 2px;
    }
    /* ── Action Card ───────────────────────────────────────────────── */
    .sprinkle-action-card {
      display: flex;
      flex-direction: column;
      background: var(--s-bg-card);
      border: 1px solid var(--s-border-subtle);
      border-radius: var(--s-radius-xl);
      overflow: hidden;
    }
    .sprinkle-action-card__header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px;
      font-weight: 700; font-size: 15px; line-height: 1.3;
      color: var(--s-text-primary);
    }
    .sprinkle-action-card__header .sprinkle-badge { margin-left: auto; }
    .sprinkle-action-card__icon {
      width: 32px; height: 32px; min-width: 32px;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; flex-shrink: 0;
      background: var(--s-bg-elevated);
    }
    .sprinkle-action-card__icon--blue   { background: var(--s-accent-soft-bg);   color: var(--s-accent-soft-text); }
    .sprinkle-action-card__icon--green  { background: var(--s-positive-soft-bg); color: var(--s-positive-soft-text); }
    .sprinkle-action-card__icon--yellow { background: var(--s-notice-soft-bg);   color: var(--s-notice-soft-text); }
    .sprinkle-action-card__icon--indigo { background: var(--s-accent-soft-bg);   color: var(--s-accent-soft-text); }
    .sprinkle-action-card__meta {
      font-size: 11px; font-weight: 400; color: var(--s-text-muted); margin-top: 2px;
    }
    .sprinkle-action-card__header-actions {
      display: flex; align-items: center; gap: 12px;
      margin-left: auto;
      font-size: 12px; font-weight: 500; color: var(--s-text-secondary);
    }
    .sprinkle-action-card__body {
      padding: 0 16px 12px;
      font-size: 14px;
      color: var(--s-text-secondary);
      line-height: 1.5;
    }
    .sprinkle-action-card__body p { margin: 0 0 8px; }
    .sprinkle-action-card__body p:last-child { margin-bottom: 0; }
    .sprinkle-action-card__actions {
      display: flex; flex-wrap: wrap;
      gap: 8px; justify-content: flex-end;
      padding: 10px 16px;
      border-top: 1px solid var(--s-border-subtle);
    }
    /* ── List Item ─────────────────────────────────────────────────── */
    .sprinkle-list-item {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px;
      border-top: 1px solid var(--s-border-subtle);
      min-height: 48px;
    }
    .sprinkle-list-item__icon {
      width: 32px; height: 32px; min-width: 32px;
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
      background: var(--s-bg-elevated); color: var(--s-text-secondary);
    }
    .sprinkle-list-item__content { flex: 1; min-width: 0; }
    .sprinkle-list-item__title {
      font-size: 14px; font-weight: 700; color: var(--s-text-primary); line-height: 1.3;
      display: flex; align-items: center; gap: 6px;
    }
    .sprinkle-list-item__subtitle {
      font-size: 13px; font-weight: 400; color: var(--s-text-muted); line-height: 1.45;
      margin-top: 2px;
    }
    .sprinkle-list-item__end { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    /* ── Table ─────────────────────────────────────────────────────── */
    .sprinkle-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      border: 1px solid var(--s-border-subtle);
      border-radius: var(--s-radius-md);
      overflow: hidden;
    }
    .sprinkle-table th {
      text-align: left;
      padding: 8px 12px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid var(--s-border-subtle);
      color: var(--s-text-secondary);
      font-weight: 700; font-size: 12px;
    }
    .sprinkle-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--s-border-subtle);
      color: var(--s-text-primary);
    }
    .sprinkle-table tr:last-child td { border-bottom: none; }
    /* ── Key-Value ─────────────────────────────────────────────────── */
    .sprinkle-kv-list { list-style: none; padding: 0; margin: 0; }
    .sprinkle-kv-list li {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--s-border-subtle);
      font-size: 13px;
    }
    .sprinkle-kv-list li:last-child { border-bottom: none; }
    .sprinkle-kv-list .key { color: var(--s-text-muted); font-weight: 400; }
    .sprinkle-kv-list .value { color: var(--s-text-primary); font-weight: 600; }
    /* ── Form fields ───────────────────────────────────────────────── */
    input[type="text"], input[type="number"], textarea, select {
      width: 100%;
      padding: 8px 12px;
      font: -apple-system-body;
      font-size: 14px;
      color: var(--s-text-primary);
      background: var(--s-bg-elevated);
      border: 1px solid var(--s-border-default);
      border-radius: var(--s-radius-md);
      outline: none;
    }
    input[type="text"]::placeholder, textarea::placeholder { color: var(--s-text-faint); }
    input[type="text"]:focus, input[type="number"]:focus, textarea:focus, select:focus {
      border-color: var(--s-accent);
      box-shadow: 0 0 0 1px var(--s-accent);
    }
    /* ── Layout helpers ────────────────────────────────────────────── */
    .sprinkle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .sprinkle-stack { display: flex; flex-direction: column; gap: 12px; }
    .sprinkle-row { display: flex; align-items: center; gap: 12px; }
    .sprinkle-divider { border: none; border-top: 1px solid var(--s-border-subtle); margin: 12px 0; }
    .sprinkle-heading { font-size: 16px; font-weight: 700; margin: 0 0 6px; color: var(--s-text-primary); line-height: 1.3; }
    .sprinkle-heading--m { font-size: 14px; }
    .sprinkle-body { font-size: 14px; color: var(--s-text-secondary); line-height: 1.5; }
    .sprinkle-detail { font-size: 12px; font-weight: 500; color: var(--s-text-muted); }
    /* ── Progress bar ──────────────────────────────────────────────── */
    .sprinkle-progress-bar {
      height: 4px; width: 100%;
      border-radius: var(--s-radius-pill);
      background: rgba(255,255,255,0.10);
      overflow: hidden;
      position: relative;
    }
    .sprinkle-progress-bar > .fill {
      height: 100%;
      background: var(--s-accent);
      border-radius: var(--s-radius-pill);
      transition: width 300ms ease;
    }
    """


    // MARK: - Bridge JS

    private static let bridgeJS: String = """
    (function() {
      function send(op, payload) {
        try {
          window.webkit.messageHandlers.sliccInline.postMessage(Object.assign({ op: op }, payload || {}));
        } catch (e) {}
      }
      window.__sliccReportHeight = function() {
        const h = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          document.body.offsetHeight
        );
        send('resize', { height: h });
      };
      // Re-report whenever DOM mutates.
      const ro = new ResizeObserver(function() { window.__sliccReportHeight(); });
      document.addEventListener('DOMContentLoaded', function() {
        ro.observe(document.body);
        window.__sliccReportHeight();
      });

      window.lick = function(event) {
        const body = (typeof event === 'string') ? { action: event } : event;
        send('lick', { body: body });
      };
      // Sprinkles in the wild call `slicc.lick(...)` (matching the
      // webapp's dip bridge in packages/webapp/src/ui/dip.ts). Expose
      // the same shape under `slicc`, `bridge`, and `sprinkle` so any
      // of the names work — the upgrade skill's action-card buttons
      // wouldn't fire without this alias.
      var bridge = {
        lick: window.lick,
        on: function() {},
        off: function() {},
        setState: function() {},
        getState: function() { return null; },
        close: function() {},
        stopCone: function() { send('lick', { body: { action: '__stopCone__' } }); }
      };
      window.slicc = bridge;
      window.bridge = bridge;
      window.sprinkle = bridge;
    })();
    """
}

// MARK: - Helpers

/// Detect ` ```shtml ` fenced code blocks AND bare top-level
/// `<div class="sprinkle-...">…</div>` blocks inside a markdown content
/// string. Returns the original text with each block replaced by a
/// `\u{FFFC}\u{FFFC}sprinkle:N\u{FFFC}\u{FFFC}` marker plus the extracted
/// fragments.
///
/// The bare-HTML path exists because the cone occasionally emits the
/// sprinkle action card without a code fence (the upgrade skill is
/// documented to use ` ```shtml `, but model output drift drops the
/// fence). Catching the raw `<div class="sprinkle-…">` form keeps the
/// card looking like a card instead of a wall of escaped HTML.
func extractInlineSprinkles(from content: String) -> (cleaned: String, fragments: [String]) {
    // Pass 1: extract fenced ```shtml blocks.
    let pass1 = extractFencedShtml(from: content)
    // Pass 2: scan the cleaned text from pass 1 for bare sprinkle divs.
    let pass2 = extractBareSprinkleDivs(from: pass1.cleaned, startIndex: pass1.fragments.count)
    return (pass2.cleaned, pass1.fragments + pass2.fragments)
}

private func extractFencedShtml(from content: String) -> (cleaned: String, fragments: [String]) {
    var fragments: [String] = []
    var cleaned = ""
    var index = content.startIndex
    while index < content.endIndex {
        if let openRange = content.range(of: "```shtml", range: index..<content.endIndex) {
            cleaned.append(contentsOf: content[index..<openRange.lowerBound])
            // Find the closing ``` on its own line
            let afterOpen = openRange.upperBound
            // Skip optional trailing language tokens / newline up to first newline
            var bodyStart = afterOpen
            if let nl = content.range(of: "\n", range: afterOpen..<content.endIndex) {
                bodyStart = nl.upperBound
            } else {
                cleaned.append(contentsOf: content[openRange.lowerBound..<content.endIndex])
                index = content.endIndex
                break
            }
            if let closeRange = content.range(of: "\n```", range: bodyStart..<content.endIndex) {
                let fragment = String(content[bodyStart..<closeRange.lowerBound])
                fragments.append(fragment)
                cleaned.append(sprinkleMarker(index: fragments.count - 1))
                index = closeRange.upperBound
                // Skip the trailing newline after ``` if present
                if index < content.endIndex, content[index] == "\n" {
                    index = content.index(after: index)
                }
            } else {
                // Unterminated block — leave the rest as plain text.
                cleaned.append(contentsOf: content[openRange.lowerBound..<content.endIndex])
                index = content.endIndex
                break
            }
        } else {
            cleaned.append(contentsOf: content[index..<content.endIndex])
            index = content.endIndex
        }
    }
    return (cleaned, fragments)
}

/// Scan `content` for top-level `<div class="sprinkle-…">…</div>` blocks
/// where `class` contains a `sprinkle-` token. Pairs opening and closing
/// `<div>` tags via depth counting so nested divs stay inside the
/// fragment. `startIndex` offsets the marker numbering so callers can
/// concatenate fragments from multiple passes.
private func extractBareSprinkleDivs(
    from content: String,
    startIndex: Int
) -> (cleaned: String, fragments: [String]) {
    var fragments: [String] = []
    var cleaned = ""
    var i = content.startIndex
    while i < content.endIndex {
        guard let openStart = findSprinkleDivOpen(in: content, from: i) else {
            cleaned.append(contentsOf: content[i..<content.endIndex])
            break
        }
        cleaned.append(contentsOf: content[i..<openStart])
        // Walk forward, depth-counting <div> / </div> until we reach the
        // matching close. If anything looks malformed (unterminated tag,
        // missing close), bail out and keep the rest as text — better
        // than swallowing half a message into an iframe.
        guard let blockEnd = matchDivBlockEnd(in: content, openStart: openStart) else {
            cleaned.append(contentsOf: content[openStart..<content.endIndex])
            break
        }
        let fragment = String(content[openStart..<blockEnd])
        fragments.append(fragment)
        cleaned.append(sprinkleMarker(index: startIndex + fragments.count - 1))
        i = blockEnd
        // Swallow a trailing newline so the marker doesn't leave a blank line.
        if i < content.endIndex, content[i] == "\n" {
            i = content.index(after: i)
        }
    }
    return (cleaned, fragments)
}

/// Locate the next `<div ... class="… sprinkle-… …" …>` opening tag.
/// Case-insensitive on the tag name; class attribute is searched for a
/// `sprinkle-` token to avoid matching unrelated classes named e.g.
/// `my-sprinkle-toy`.
private func findSprinkleDivOpen(in content: String, from start: String.Index) -> String.Index? {
    var cursor = start
    while cursor < content.endIndex {
        guard let lt = content.range(of: "<", range: cursor..<content.endIndex) else { return nil }
        let afterLt = lt.upperBound
        // Match `div` (case insensitive) followed by whitespace.
        if afterLt < content.endIndex {
            let three = content[afterLt..<min(content.index(afterLt, offsetBy: 3, limitedBy: content.endIndex) ?? content.endIndex,
                                              content.endIndex)]
            if three.lowercased() == "div" {
                let afterDiv = content.index(afterLt, offsetBy: 3, limitedBy: content.endIndex) ?? content.endIndex
                if afterDiv < content.endIndex,
                   content[afterDiv].isWhitespace || content[afterDiv] == ">" {
                    if let tagEnd = content.range(of: ">", range: afterDiv..<content.endIndex) {
                        let tagText = content[lt.lowerBound..<tagEnd.upperBound]
                        if isSprinkleClassed(tagText) {
                            return lt.lowerBound
                        }
                        cursor = tagEnd.upperBound
                        continue
                    }
                    return nil
                }
            }
        }
        cursor = afterLt
    }
    return nil
}

/// Returns `true` when the given opening tag string contains a class
/// attribute whose value includes a token starting with `sprinkle-`.
private func isSprinkleClassed(_ tag: Substring) -> Bool {
    // Match class="…" or class='…' (case-insensitive on the attribute name).
    let lower = tag.lowercased()
    guard let classRange = lower.range(of: "class") else { return false }
    let after = lower[classRange.upperBound...]
    // Skip whitespace + `=` + optional whitespace.
    var idx = after.startIndex
    while idx < after.endIndex, after[idx].isWhitespace { idx = after.index(after: idx) }
    guard idx < after.endIndex, after[idx] == "=" else { return false }
    idx = after.index(after: idx)
    while idx < after.endIndex, after[idx].isWhitespace { idx = after.index(after: idx) }
    guard idx < after.endIndex else { return false }
    let quote = after[idx]
    guard quote == "\"" || quote == "'" else { return false }
    idx = after.index(after: idx)
    guard let closeQuote = after[idx...].firstIndex(of: quote) else { return false }
    let classValue = after[idx..<closeQuote]
    // Tokenize on whitespace and look for any token beginning with `sprinkle-`.
    return classValue.split(whereSeparator: { $0.isWhitespace }).contains { $0.hasPrefix("sprinkle-") }
}

/// Given the start of a `<div…>`, return the index just past the matching
/// `</div>`. `nil` if the block is unterminated (e.g. the message was
/// truncated mid-stream) — callers fall back to plain text.
private func matchDivBlockEnd(in content: String, openStart: String.Index) -> String.Index? {
    // Find end of the opening tag itself first.
    guard let openTagEnd = content.range(of: ">", range: openStart..<content.endIndex) else {
        return nil
    }
    var depth = 1
    var cursor = openTagEnd.upperBound
    while cursor < content.endIndex {
        guard let lt = content.range(of: "<", range: cursor..<content.endIndex) else { return nil }
        let afterLt = lt.upperBound
        if afterLt < content.endIndex, content[afterLt] == "/" {
            // </div…>
            let afterSlash = content.index(after: afterLt)
            if afterSlash < content.endIndex {
                let endLimit = content.index(afterSlash, offsetBy: 3, limitedBy: content.endIndex) ?? content.endIndex
                let three = content[afterSlash..<endLimit]
                if three.lowercased() == "div" {
                    guard let gt = content.range(of: ">", range: endLimit..<content.endIndex) else {
                        return nil
                    }
                    depth -= 1
                    if depth == 0 { return gt.upperBound }
                    cursor = gt.upperBound
                    continue
                }
            }
            cursor = afterLt
        } else {
            // Possibly <div…> opening — bump depth.
            let endLimit = content.index(afterLt, offsetBy: 3, limitedBy: content.endIndex) ?? content.endIndex
            let three = content[afterLt..<endLimit]
            if three.lowercased() == "div",
               endLimit < content.endIndex,
               content[endLimit].isWhitespace || content[endLimit] == ">" {
                guard let gt = content.range(of: ">", range: endLimit..<content.endIndex) else {
                    return nil
                }
                // Self-closing `<div … />` doesn't push depth.
                let openTag = content[lt.lowerBound..<gt.upperBound]
                if !openTag.hasSuffix("/>") {
                    depth += 1
                }
                cursor = gt.upperBound
            } else {
                cursor = afterLt
            }
        }
    }
    return nil
}

private func sprinkleMarker(index: Int) -> String {
    return "\u{FFFC}\u{FFFC}sprinkle:\(index)\u{FFFC}\u{FFFC}\n"
}
