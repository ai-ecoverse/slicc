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
        <style>
          html, body { background:transparent; color:#fff; margin:0; padding:0; font: -apple-system-body; }
          body { padding: 6px 0; overflow: hidden; }
          a { color:#7B9FFF; }
          .sprinkle-action-card {
            background:#1A1A2E; border-radius:12px; padding:12px;
            border:1px solid rgba(255,255,255,0.08);
          }
          button {
            font: -apple-system-body; padding:8px 14px; border-radius:8px;
            border:1px solid rgba(255,255,255,0.15); background:#252540;
            color:#fff; margin:4px 4px 0 0;
          }
        </style>
        </head><body>
        \(fragment)
        </body></html>
        """
    }

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
      window.sprinkle = {
        lick: window.lick,
        on: function() {},
        off: function() {},
        setState: function() {},
        getState: function() { return null; },
        close: function() {},
        stopCone: function() { send('lick', { body: { action: '__stopCone__' } }); }
      };
    })();
    """
}

// MARK: - Helpers

/// Detect ` ```shtml ` fenced code blocks inside a markdown content string and
/// return the original text with each block replaced by a placeholder, plus
/// the extracted shtml fragments.
func extractInlineSprinkles(from content: String) -> (cleaned: String, fragments: [String]) {
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
                cleaned.append("\u{FFFC}\u{FFFC}sprinkle:\(fragments.count - 1)\u{FFFC}\u{FFFC}\n")
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
