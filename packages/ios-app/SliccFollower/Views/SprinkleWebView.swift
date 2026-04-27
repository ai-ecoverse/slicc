import SwiftUI
import WebKit
import os

/// SwiftUI wrapper around WKWebView that renders a `.shtml` sprinkle.
///
/// Bridges the sprinkle's JS surface (`window.sprinkle.*`) to the Swift side:
///   - `lick({action, data})` → forwarded to the leader as `sprinkle.lick`
///   - `on('update', cb)` / `off` → receives `sprinkle.update` payloads
///   - `setState(data)` / `getState()` → UserDefaults-backed (per-sprinkle key)
///   - `close()` → invokes the dismiss closure
///   - `stopCone()` → emits a special lick `{action: '__stopCone__'}` (handled by leader)
///   - `screenshot(selector?)` → page-side canvas screenshot returning data URL
///
/// VFS file APIs (`readFile`, `writeFile`, `readDir`, `stat`, …) are stubbed
/// out and reject — the iOS follower doesn't proxy fs.* yet. Sprinkles that
/// rely on filesystem access will degrade gracefully.
struct SprinkleWebView: UIViewRepresentable {
    let sprinkleName: String
    let sprinkleTitle: String
    /// Raw .shtml content fetched from the leader.
    let sprinkleContent: String
    /// Stream of `sprinkle.update` payloads keyed by sprinkleName, observed by the bridge.
    let updates: AnyCodable?
    /// Lick callback — forwards to AppState.sendSprinkleLick.
    var onLick: (_ body: AnyCodable?, _ targetScoop: String?) -> Void
    /// Dismiss callback for `sprinkle.close()`.
    var onClose: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: "sliccBridge")

        // Inject the bridge script before the page loads.
        let escapedName = sprinkleName
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let bridgeScript = WKUserScript(
            source: Self.bridgeJS.replacingOccurrences(of: "__SPRINKLE_NAME__", with: escapedName),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContent.addUserScript(bridgeScript)
        config.userContentController = userContent

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.06, green: 0.06, blue: 0.10, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor

        context.coordinator.webView = webView
        webView.loadHTMLString(Self.wrap(sprinkleContent), baseURL: URL(string: "about:blank"))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Reload the page if the sprinkle content changes.
        if context.coordinator.lastContent != sprinkleContent {
            context.coordinator.lastContent = sprinkleContent
            webView.loadHTMLString(Self.wrap(sprinkleContent), baseURL: URL(string: "about:blank"))
        }
        // Forward any pending sprinkle.update payload.
        if let data = updates {
            context.coordinator.deliverUpdate(data)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "sliccBridge")
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let parent: SprinkleWebView
        weak var webView: WKWebView?
        var lastContent: String = ""
        private let logger = Logger(subsystem: "com.slicc.follower", category: "SprinkleWebView")

        init(parent: SprinkleWebView) {
            self.parent = parent
        }

        // MARK: WKScriptMessageHandler

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "sliccBridge",
                  let dict = message.body as? [String: Any],
                  let op = dict["op"] as? String else { return }

            switch op {
            case "lick":
                let body = dict["body"]
                let targetScoop = dict["targetScoop"] as? String
                let coded = body.flatMap(AnyCodable.init)
                parent.onLick(coded, targetScoop)

            case "stopCone":
                // Emit a special lick action so the leader can route it.
                let body = AnyCodable(["action": "__stopCone__"])
                parent.onLick(body, nil)

            case "close":
                parent.onClose()

            case "setState":
                let key = "slicc-sprinkle-state:\(parent.sprinkleName)"
                if let value = dict["data"], !(value is NSNull) {
                    if let data = try? JSONSerialization.data(withJSONObject: value),
                       let str = String(data: data, encoding: .utf8) {
                        UserDefaults.standard.set(str, forKey: key)
                    }
                } else {
                    UserDefaults.standard.removeObject(forKey: key)
                }

            case "log":
                if let msg = dict["message"] as? String {
                    logger.debug("[\(self.parent.sprinkleName, privacy: .public)] \(msg, privacy: .public)")
                }

            default:
                logger.debug("Unknown sprinkle bridge op: \(op, privacy: .public)")
            }
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Hydrate persisted state into the page.
            let key = "slicc-sprinkle-state:\(parent.sprinkleName)"
            let stateJson = UserDefaults.standard.string(forKey: key) ?? "null"
            let escaped = stateJson
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            webView.evaluateJavaScript("__sliccSetCachedState('\(escaped)')", completionHandler: nil)
        }

        // MARK: Pushed updates

        func deliverUpdate(_ data: AnyCodable) {
            guard let webView = webView else { return }
            guard let payload = try? JSONEncoder().encode(data),
                  let str = String(data: payload, encoding: .utf8) else { return }
            let escaped = str
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            webView.evaluateJavaScript("__sliccDispatchUpdate('\(escaped)')", completionHandler: nil)
        }
    }

    // MARK: - HTML Wrapping

    /// Inject required helpers + the raw sprinkle content into a minimal HTML host.
    /// Sprinkles can be:
    ///  - Fragments (no <html>) → wrapped automatically
    ///  - Full documents (with <html>/<head>) → inserted as-is
    private static func wrap(_ content: String) -> String {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let isFullDocument = trimmed.lowercased().hasPrefix("<!doctype")
            || trimmed.lowercased().contains("<html")
        if isFullDocument {
            return content
        }
        return """
        <!DOCTYPE html>
        <html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        <style>
          html, body { background:#0F0F1A; color:#fff; margin:0; padding:0; font: -apple-system-body; }
          body { padding: 12px; }
          a { color: #7B9FFF; }
          button { font: -apple-system-body; }
        </style>
        </head><body>
        \(content)
        </body></html>
        """
    }

    // MARK: - Bridge JavaScript

    /// JS injected at document-start. Defines `window.sprinkle` with a subset
    /// of the SprinkleBridgeAPI surface used by sprinkles.
    private static let bridgeJS: String = """
    (function() {
      const updateListeners = new Set();
      let cachedState = null;

      window.__sliccSetCachedState = function(stateJson) {
        try { cachedState = stateJson === 'null' ? null : JSON.parse(stateJson); }
        catch (e) { cachedState = null; }
      };

      window.__sliccDispatchUpdate = function(payloadJson) {
        let data = null;
        try { data = JSON.parse(payloadJson); } catch (e) { return; }
        for (const cb of updateListeners) {
          try { cb(data); } catch (e) {}
        }
      };

      function send(op, payload) {
        try {
          window.webkit.messageHandlers.sliccBridge.postMessage(Object.assign({ op: op }, payload || {}));
        } catch (e) {}
      }

      const sprinkle = {
        get name() { return '__SPRINKLE_NAME__'; },
        lick: function(event) {
          const body = (typeof event === 'string') ? { action: event } : event;
          send('lick', { body: body });
        },
        on: function(eventName, cb) {
          if (eventName === 'update') updateListeners.add(cb);
        },
        off: function(eventName, cb) {
          if (eventName === 'update') updateListeners.delete(cb);
        },
        setState: function(data) { send('setState', { data: data }); },
        getState: function() { return cachedState; },
        close: function() { send('close'); },
        stopCone: function() { send('stopCone'); },
        // Filesystem APIs are stubbed on iOS — sprinkles that need them
        // should detect availability and degrade.
        readFile: function() { return Promise.reject(new Error('readFile not supported on iOS follower')); },
        writeFile: function() { return Promise.reject(new Error('writeFile not supported on iOS follower')); },
        readDir: function() { return Promise.reject(new Error('readDir not supported on iOS follower')); },
        exists: function() { return Promise.resolve(false); },
        stat: function() { return Promise.reject(new Error('stat not supported on iOS follower')); },
        mkdir: function() { return Promise.reject(new Error('mkdir not supported on iOS follower')); },
        rm: function() { return Promise.reject(new Error('rm not supported on iOS follower')); },
        screenshot: function() { return Promise.reject(new Error('screenshot not supported')); },
        open: function(url) { window.open(url, '_blank'); }
      };

      window.sprinkle = sprinkle;
      // SLICC-bridge alias used by some sprinkles.
      window.lick = sprinkle.lick.bind(sprinkle);
    })();
    """
}
