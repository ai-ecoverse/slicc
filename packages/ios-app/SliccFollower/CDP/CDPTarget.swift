import Foundation
import SliccTrayKit
import UIKit
import WebKit
import os







@MainActor
final class CDPTarget: NSObject {

    

    
    let targetId: String
    
    var sessionId: String?

    

    let webView: WKWebView

    

    
    private(set) var currentURL: String = "about:blank"
    
    private(set) var currentTitle: String = ""
    
    let frameId: String
    
    private var loaderCounter: Int = 0
    
    var pageEnabled: Bool = false
    
    var runtimeEnabled: Bool = false
    
    var domEnabled: Bool = false

    
    private(set) var newDocumentScripts: [String: String] = [:]  
    private var nextScriptId: Int = 1

    
    private let executionContextId: Int

    
    weak var bridge: CDPBridge?

    

    init(targetId: String, webView: WKWebView, contextId: Int) {
        self.targetId = targetId
        self.webView = webView
        self.frameId = "frame-\(targetId)"
        self.executionContextId = contextId
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    

    func targetInfo() -> [String: Any] {
        return [
            "targetId": targetId,
            "type": "page",
            "title": currentTitle,
            "url": currentURL,
            "attached": sessionId != nil,
            "browserContextId": "default",
        ]
    }

    
    
    
    
    
    
    
    func remoteInfo() -> RemoteTargetInfo {
        RemoteTargetInfo(
            targetId: targetId,
            title: currentTitle,
            url: currentURL,
            kind: "browser",
            capabilities: CherryCapabilities(navigate: true, network: true, screenshot: true))
    }

    

    @discardableResult
    func navigate(to urlString: String) -> [String: Any] {
        loaderCounter += 1
        let loaderId = "loader-\(targetId)-\(loaderCounter)"
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
            return ["frameId": frameId, "loaderId": loaderId]
        }
        return ["frameId": frameId, "loaderId": loaderId, "errorText": "Invalid URL"]
    }

    func reload() {
        webView.reload()
    }

    func goBack() {
        webView.goBack()
    }

    func goForward() {
        webView.goForward()
    }

    

    
    func runtimeEvaluate(
        expression: String,
        awaitPromise: Bool,
        returnByValue: Bool,
        completion: @escaping ([String: Any]) -> Void
    ) {
        if awaitPromise {
            
            
            
            
            
            
            let wrapped = """
                try {
                  const __r = await (\(expression));
                  return { ok: true, value: __r };
                } catch (e) {
                  return { ok: false, error: String((e && e.stack) || e) };
                }
                """
            webView.callAsyncJavaScript(wrapped, in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    completion(self.encodeEvaluateResult(value, returnByValue: returnByValue))
                case .failure(let err):
                    completion(self.encodeException(err.localizedDescription))
                }
            }
        } else {
            
            let wrapped =
                "(function() { try { return { ok: true, value: (\(expression)) }; } catch(e) { return { ok: false, error: String((e && e.stack) || e) }; } })()"
            webView.evaluateJavaScript(wrapped) { value, error in
                if let error {
                    completion(self.encodeException(error.localizedDescription))
                    return
                }
                completion(self.encodeEvaluateResult(value, returnByValue: returnByValue))
            }
        }
    }

    private func encodeEvaluateResult(_ value: Any?, returnByValue: Bool) -> [String: Any] {
        if let dict = value as? [String: Any], let ok = dict["ok"] as? Bool {
            if ok {
                let raw = dict["value"]
                return [
                    "result": cdpRemoteObject(raw, returnByValue: returnByValue)
                ]
            } else {
                let err = (dict["error"] as? String) ?? "evaluate failed"
                return encodeException(err)
            }
        }
        return [
            "result": cdpRemoteObject(value, returnByValue: returnByValue)
        ]
    }

    private func encodeException(_ description: String) -> [String: Any] {
        return [
            "result": [
                "type": "object",
                "subtype": "error",
                "description": description,
            ],
            "exceptionDetails": [
                "exceptionId": 1,
                "text": description,
                "lineNumber": 0,
                "columnNumber": 0,
            ],
        ]
    }

    private func cdpRemoteObject(_ value: Any?, returnByValue: Bool) -> [String: Any] {
        guard let value = value, !(value is NSNull) else {
            return ["type": "undefined"]
        }
        if let s = value as? String {
            return ["type": "string", "value": s]
        }
        if let n = value as? NSNumber {
            
            let typeStr = String(cString: n.objCType)
            if typeStr == "c" || typeStr == "B" {
                return ["type": "boolean", "value": n.boolValue]
            }
            return ["type": "number", "value": n.doubleValue]
        }
        if let arr = value as? [Any] {
            return [
                "type": "object",
                "subtype": "array",
                "className": "Array",
                "description": "Array(\(arr.count))",
                "value": returnByValue ? arr : [],
            ]
        }
        if let dict = value as? [String: Any] {
            return [
                "type": "object",
                "className": "Object",
                "description": "Object",
                "value": returnByValue ? dict : [:],
            ]
        }
        return ["type": "object", "description": String(describing: value)]
    }

    

    func captureScreenshot(format: String, quality: Int?, completion: @escaping (Result<String, Error>) -> Void) {
        let cfg = WKSnapshotConfiguration()
        cfg.afterScreenUpdates = true
        webView.takeSnapshot(with: cfg) { image, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let image else {
                completion(
                    .failure(
                        NSError(
                            domain: "CDP", code: -1,
                            userInfo: [NSLocalizedDescriptionKey: "Snapshot returned no image"])))
                return
            }
            let data: Data?
            switch format {
            case "jpeg":
                let q = max(0.0, min(1.0, Double(quality ?? 80) / 100.0))
                data = image.jpegData(compressionQuality: CGFloat(q))
            default:
                data = image.pngData()
            }
            if let data {
                completion(.success(data.base64EncodedString()))
            } else {
                completion(
                    .failure(
                        NSError(
                            domain: "CDP", code: -1,
                            userInfo: [NSLocalizedDescriptionKey: "Failed to encode screenshot data"])))
            }
        }
    }

    

    func addScriptToEvaluateOnNewDocument(_ source: String) -> String {
        let id = "script-\(targetId)-\(nextScriptId)"
        nextScriptId += 1
        newDocumentScripts[id] = source
        let userScript = WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        webView.configuration.userContentController.addUserScript(userScript)
        return id
    }

    func removeScriptToEvaluateOnNewDocument(_ identifier: String) {
        newDocumentScripts.removeValue(forKey: identifier)
        
        let remaining = newDocumentScripts.values
        webView.configuration.userContentController.removeAllUserScripts()
        for source in remaining {
            let userScript = WKUserScript(
                source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false)
            webView.configuration.userContentController.addUserScript(userScript)
        }
    }

    

    fileprivate func emit(_ method: String, _ params: [String: Any]) {
        bridge?.emitEvent(method: method, params: params, sessionId: sessionId)
    }

    fileprivate func emitFrameNavigated() {
        emit(
            "Page.frameNavigated",
            [
                "frame": [
                    "id": frameId,
                    "loaderId": "loader-\(targetId)-\(loaderCounter)",
                    "url": currentURL,
                    "securityOrigin": "",
                    "mimeType": "text/html",
                ]
            ])
    }

    fileprivate func emitLifecycle(_ name: String) {
        emit(
            "Page.lifecycleEvent",
            [
                "frameId": frameId,
                "loaderId": "loader-\(targetId)-\(loaderCounter)",
                "name": name,
                "timestamp": Date().timeIntervalSince1970,
            ])
    }
}



extension CDPTarget: WKNavigationDelegate {

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if let url = webView.url?.absoluteString { currentURL = url }
        bridge?.notifyTargetsChanged()
        guard pageEnabled else { return }
        emitLifecycle("init")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if let url = webView.url?.absoluteString { currentURL = url }
        bridge?.notifyTargetsChanged()
        guard pageEnabled else { return }
        emitFrameNavigated()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url?.absoluteString { currentURL = url }
        currentTitle = webView.title ?? ""
        bridge?.notifyTargetsChanged()
        guard pageEnabled else { return }
        emit("Page.loadEventFired", ["timestamp": Date().timeIntervalSince1970])
        emitLifecycle("load")
        emitLifecycle("DOMContentLoaded")
        emitLifecycle("networkIdle")
    }

    
    
    
    
    
    
    
    
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        defer { decisionHandler(.allow) }
        guard
            let handoff = Self.handoff(
                isForMainFrame: navigationResponse.isForMainFrame,
                response: navigationResponse.response,
                fallbackURL: currentURL)
        else { return }
        bridge?.reportHandoff(
            pageURL: handoff.pageURL, match: handoff.match, title: webView.title)
    }

    
    
    
    nonisolated static func handoff(
        isForMainFrame: Bool, response: URLResponse?, fallbackURL: String
    ) -> (pageURL: String, match: HandoffMatch)? {
        
        
        guard isForMainFrame,
            let http = response as? HTTPURLResponse,
            let header = http.value(forHTTPHeaderField: "Link"),
            !header.isEmpty
        else { return nil }

        let pageURL = http.url?.absoluteString ?? fallbackURL
        let links = LinkHeader.parse(header, baseURL: pageURL)
        guard let match = HandoffLink.extract(from: links) else { return nil }
        return (pageURL, match)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard pageEnabled else { return }
        emit(
            "Page.lifecycleEvent",
            [
                "frameId": frameId,
                "loaderId": "loader-\(targetId)-\(loaderCounter)",
                "name": "load",
                "timestamp": Date().timeIntervalSince1970,
            ])
        emit("Page.loadEventFired", ["timestamp": Date().timeIntervalSince1970])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard pageEnabled else { return }
        emit("Page.loadEventFired", ["timestamp": Date().timeIntervalSince1970])
    }
}



extension CDPTarget: WKUIDelegate {

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        if pageEnabled {
            emit(
                "Page.javascriptDialogOpening",
                [
                    "url": currentURL, "message": message, "type": "alert", "defaultPrompt": "",
                ])
        }
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        if pageEnabled {
            emit(
                "Page.javascriptDialogOpening",
                [
                    "url": currentURL, "message": message, "type": "confirm", "defaultPrompt": "",
                ])
        }
        completionHandler(false)
    }
}
