import SwiftUI
import WebKit

/// SwiftUI wrapper around WKWebView that renders ChatMessage[] as rich HTML.
/// Loads chat.html/css/js from the app bundle and bridges data via evaluateJavaScript.
struct MessageWebView: UIViewRepresentable {
    let messages: [ChatMessage]
    var isStreaming: Bool = false
    var onLinkTapped: ((URL) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "linkHandler")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.102, green: 0.102, blue: 0.102, alpha: 1) // #1a1a1a
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false

        // Disable zoom
        webView.scrollView.minimumZoomScale = 1.0
        webView.scrollView.maximumZoomScale = 1.0
        webView.scrollView.bouncesZoom = false

        // Load chat.html from bundle
        if let htmlURL = Bundle.main.url(forResource: "chat", withExtension: "html",
                                          subdirectory: nil) {
            webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        }

        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let coordinator = context.coordinator
        // Only send messages after the page has loaded
        guard coordinator.isPageLoaded else {
            coordinator.pendingMessages = messages
            coordinator.pendingStreaming = isStreaming
            return
        }

        // Encode messages and send to JS
        coordinator.loadMessages(messages)
        coordinator.setStreaming(isStreaming)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "linkHandler")
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let parent: MessageWebView
        weak var webView: WKWebView?
        var isPageLoaded = false
        var pendingMessages: [ChatMessage]?
        var pendingStreaming: Bool?

        init(parent: MessageWebView) {
            self.parent = parent
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isPageLoaded = true
            // Flush any pending messages
            if let messages = pendingMessages {
                loadMessages(messages)
                pendingMessages = nil
            }
            if let streaming = pendingStreaming {
                setStreaming(streaming)
                pendingStreaming = nil
            }
        }

        // MARK: WKScriptMessageHandler

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            if message.name == "linkHandler", let urlString = message.body as? String,
               let url = URL(string: urlString) {
                parent.onLinkTapped?(url)
            }
        }

        // MARK: JS Bridge Methods

        func loadMessages(_ messages: [ChatMessage]) {
            guard let webView = webView else { return }
            do {
                let encoder = JSONEncoder()
                let data = try encoder.encode(messages)
                guard let json = String(data: data, encoding: .utf8) else { return }
                let escaped = json.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "'", with: "\\'")
                    .replacingOccurrences(of: "\n", with: "\\n")
                let script = "loadMessages('\(escaped)')"
                webView.evaluateJavaScript(script) { _, error in
                    if let error = error {
                        print("[MessageWebView] loadMessages error: \(error)")
                    }
                }
            } catch {
                print("[MessageWebView] encode error: \(error)")
            }
        }

        func setStreaming(_ isStreaming: Bool) {
            guard let webView = webView else { return }
            webView.evaluateJavaScript("setStreaming(\(isStreaming))") { _, _ in }
        }

        /// Start a new streaming assistant message.
        func startMessage(id: String) {
            guard let webView = webView else { return }
            let escaped = id.replacingOccurrences(of: "'", with: "\\'")
            webView.evaluateJavaScript("startMessage('\(escaped)')") { _, _ in }
        }

        /// Append a text delta to a streaming message.
        func appendDelta(messageId: String, text: String) {
            guard let webView = webView else { return }
            let eid = messageId.replacingOccurrences(of: "'", with: "\\'")
            let et = text.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            webView.evaluateJavaScript("appendDelta('\(eid)','\(et)')") { _, _ in }
        }

        /// Mark a streaming message as finished.
        func finishMessage(id: String) {
            guard let webView = webView else { return }
            let escaped = id.replacingOccurrences(of: "'", with: "\\'")
            webView.evaluateJavaScript("finishMessage('\(escaped)')") { _, _ in }
        }

        /// Add a tool use to a message.
        func addToolUse(messageId: String, toolName: String, toolInput: String) {
            guard let webView = webView else { return }
            let eid = messageId.replacingOccurrences(of: "'", with: "\\'")
            let en = toolName.replacingOccurrences(of: "'", with: "\\'")
            let ei = toolInput.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            webView.evaluateJavaScript("addToolUse('\(eid)','\(en)','\(ei)')") { _, _ in }
        }
    }
}

